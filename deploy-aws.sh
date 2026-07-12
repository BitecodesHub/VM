#!/usr/bin/env bash
# One-shot deploy of PRISM Virtual Desktop onto a fresh Ubuntu 24.04 (arm64) host
# with NATIVE Docker (no Colima). Idempotent; run as root:
#   sudo bash deploy-aws.sh <public-host-or-ip>
#
# Bridges the Mac→Linux gap with two override seams the app already supports:
#   VMP_DOCKER=/usr/bin/docker      (Linux docker path)
#   VMP_COLIMA=/usr/local/bin/colima-shim   (reports the host as an always-up "VM")
# Only Caddy is exposed publicly (443/5443); the panel binds loopback.
set -euo pipefail

PUBLIC_HOST="${1:?usage: sudo bash deploy-aws.sh <public-host-or-ip>}"
APP_DIR="${APP_DIR:-/opt/vm-panel}"
RUN_USER="${RUN_USER:-ubuntu}"

echo "[1/7] Base packages (Node 20, Docker, Caddy)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs docker.io caddy
systemctl enable --now docker
usermod -aG docker "$RUN_USER" || true

echo "[2/7] Colima shim (native host has no VM to manage)…"
cat > /usr/local/bin/colima-shim <<'SHIM'
#!/bin/sh
# Emulates just enough of `colima list --json` for the panel: report the host as
# a single running "VM" with its real CPU/RAM/disk. start/stop are no-ops.
if [ "$1" = "list" ]; then
  CPUS=$(nproc)
  MEM=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) * 1024 ))
  DISK=$(df -B1 / | awk 'NR==2{print $2}')
  printf '{"name":"default","status":"Running","cpus":%s,"memory":%s,"disk":%s,"arch":"%s"}\n' "$CPUS" "$MEM" "$DISK" "$(uname -m)"
fi
exit 0
SHIM
chmod 0755 /usr/local/bin/colima-shim

echo "[3/7] Optional webcam module (best-effort)…"
apt-get install -y "linux-headers-$(uname -r)" v4l2loopback-dkms v4l2loopback-utils 2>/dev/null && \
  modprobe v4l2loopback devices=1 video_nr=0 card_label=VMPanelCam exclusive_caps=1 2>/dev/null && \
  chmod 0666 /dev/video0 2>/dev/null || echo "  (webcam unavailable — audio/mic still work)"

echo "[4/7] Building desktop images (this is the slow part)…"
docker build -t minimal-linux-desktop:xfce "$APP_DIR/images/linux-desktop" || echo "  WARN: linux-desktop build failed"
docker build -t minimal-media-desktop:xfce "$APP_DIR/images/media-desktop" || echo "  WARN: media-desktop build failed"

echo "[5/7] Panel runtime config…"
mkdir -p "$APP_DIR/data"
cat > "$APP_DIR/data/config.json" <<CFG
{"bind":"127.0.0.1","publicTls":true,"publicHost":"$PUBLIC_HOST","panelHttpsPort":443,"machineHttpsPort":5443}
CFG
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

echo "[6/7] systemd unit + Caddy front…"
cat > /etc/systemd/system/vm-panel.service <<UNIT
[Unit]
Description=PRISM Virtual Desktop (VM Panel)
After=docker.service
Requires=docker.service
[Service]
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=on-failure
RestartSec=3
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=VMP_BIND=127.0.0.1
Environment=VMP_DOCKER=/usr/bin/docker
Environment=VMP_COLIMA=/usr/local/bin/colima-shim
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
{
	skip_install_trust
}
:443 {
	tls internal
	reverse_proxy 127.0.0.1:5050 {
		header_up Host 127.0.0.1:5050
	}
}
:5443 {
	tls internal
	reverse_proxy 127.0.0.1:5051 {
		header_up Host 127.0.0.1:5051
	}
}
CADDY

echo "[7/7] Starting services…"
systemctl daemon-reload
systemctl enable --now vm-panel.service
systemctl restart caddy

echo "DEPLOY_OK — open https://${PUBLIC_HOST}/ to create the admin account."
echo "Caddy internal root CA (trust on clients for mic/camera): /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt"
