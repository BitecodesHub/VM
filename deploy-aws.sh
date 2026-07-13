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

echo "[4/7] Building/provisioning ALL template images (the slow part)…"
# Both desktops are KasmVNC-based (audio/mic/camera by default).
docker build -t minimal-linux-desktop:xfce   "$APP_DIR/images/linux-desktop"  || echo "  WARN: xfce desktop build failed"
docker build -t minimal-linux-desktop:icewm  "$APP_DIR/images/icewm-desktop"  || echo "  WARN: icewm desktop build failed"
# Selenium node images: pull the public multi-arch seleniarm images and retag to
# the local names the templates reference, so Chrome/Firefox nodes never try to
# pull a non-existent repo (that was the "VM not creating" 500).
docker pull seleniarm/standalone-chromium:latest && docker tag seleniarm/standalone-chromium:latest local-seleniarm/standalone-chromium:4.5.0-20260701 || echo "  WARN: chromium node image unavailable"
docker pull seleniarm/standalone-firefox:latest  && docker tag seleniarm/standalone-firefox:latest  local-seleniarm/standalone-firefox:4.5.0-20260701  || echo "  WARN: firefox node image unavailable"

echo "[5/7] Panel runtime config…"
mkdir -p "$APP_DIR/data"
cat > "$APP_DIR/data/config.json" <<CFG
{"bind":"127.0.0.1","publicTls":true,"publicHost":"$PUBLIC_HOST","panelHttpsPort":443,"machineHttpsPort":5443,"sessionIdleHours":12,"maxRunningMachines":4}
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

# Daily data backup (audit blocker: without this, users.json / secret / config /
# sessions are lost on instance replacement). Writes a verified, pruned tarball.
# BACKUP_DIR defaults to $APP_DIR/backups (on the persistent root EBS volume, so
# it survives panel/process restarts + accidental data corruption). For
# instance-LOSS durability, point VMP_BACKUP_DIR at an off-host path (a separate
# mounted EBS volume, or an rclone/S3 remote) and/or enable EBS snapshots.
BACKUP_DIR="${VMP_BACKUP_DIR:-$APP_DIR/backups}"
mkdir -p "$BACKUP_DIR"; chown -R "$RUN_USER":"$RUN_USER" "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
cat > /etc/systemd/system/vm-panel-backup.service <<UNIT
[Unit]
Description=PRISM Virtual Desktop data backup
[Service]
Type=oneshot
User=$RUN_USER
Environment=VMP_DATA_DIR=$APP_DIR/data
Environment=VMP_BACKUP_DIR=$BACKUP_DIR
ExecStart=/bin/bash $APP_DIR/launchers/backup.sh
UNIT
cat > /etc/systemd/system/vm-panel-backup.timer <<UNIT
[Unit]
Description=Daily PRISM Virtual Desktop backup
[Timer]
OnCalendar=daily
Persistent=true
[Install]
WantedBy=timers.target
UNIT

# TLS front. A DNS PUBLIC_HOST (e.g. a sslip.io magic-DNS name) gets a REAL
# Let's Encrypt cert via Caddy automatic HTTPS — no browser warning, and (the
# reason it matters) getUserMedia mic/camera work, which a cert-error origin
# blocks. A bare-IP PUBLIC_HOST cannot get a public cert, so it falls back to a
# self-signed cert with the IP in the SAN (browser warning; mic/camera limited).
if echo "$PUBLIC_HOST" | grep -qE '^[0-9.]+$'; then
	echo "  PUBLIC_HOST is a bare IP — using a self-signed cert (no public CA issues IP certs)."
	openssl req -x509 -newkey rsa:2048 -nodes \
	  -keyout /etc/caddy/vmpanel.key -out /etc/caddy/vmpanel.crt \
	  -days 3650 -subj "/CN=${PUBLIC_HOST}" \
	  -addext "subjectAltName=IP:${PUBLIC_HOST},DNS:localhost" >/dev/null 2>&1
	chown root:caddy /etc/caddy/vmpanel.key /etc/caddy/vmpanel.crt
	chmod 640 /etc/caddy/vmpanel.key; chmod 644 /etc/caddy/vmpanel.crt
	cat > /etc/caddy/Caddyfile <<CADDY
{
	auto_https disable_redirects
}
:443 {
	tls /etc/caddy/vmpanel.crt /etc/caddy/vmpanel.key
	reverse_proxy 127.0.0.1:5050 {
		header_up Host 127.0.0.1:5050
	}
}
:5443 {
	tls /etc/caddy/vmpanel.crt /etc/caddy/vmpanel.key
	reverse_proxy 127.0.0.1:5051 {
		header_up Host 127.0.0.1:5051
	}
}
CADDY
else
	echo "  PUBLIC_HOST is a DNS name — using Caddy automatic HTTPS (Let's Encrypt)."
	# Port 80 is often closed in the security group, so HTTP-01 may fail; Caddy
	# also tries TLS-ALPN-01 on 443 (open), which succeeds. Certs are cached in
	# /var/lib/caddy so restarts do not re-hit Let's Encrypt rate limits.
	cat > /etc/caddy/Caddyfile <<CADDY
${PUBLIC_HOST} {
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	reverse_proxy 127.0.0.1:5050 {
		header_up Host 127.0.0.1:5050
	}
}
${PUBLIC_HOST}:5443 {
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	reverse_proxy 127.0.0.1:5051 {
		header_up Host 127.0.0.1:5051
	}
}
CADDY
fi

echo "[7/7] Starting services…"
systemctl daemon-reload
systemctl enable --now vm-panel.service
systemctl enable --now vm-panel-backup.timer
systemctl start vm-panel-backup.service || true   # take an initial backup now
systemctl restart caddy

echo "DEPLOY_OK — open https://${PUBLIC_HOST}/ to create the admin account."
echo "TLS cert (self-signed; trust on clients or accept the warning for mic/camera): /etc/caddy/vmpanel.crt"
