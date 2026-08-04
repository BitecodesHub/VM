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
#
# These builds are FATAL on failure, deliberately. They used to be `|| echo WARN`,
# which let a host finish deploying "successfully" while a template's image was
# missing or stale — and that is exactly how this product broke in practice: the
# Dockerfiles moved from noVNC to KasmVNC, the images were never rebuilt, and every
# desktop silently became unopenable. A deploy that cannot build the images it
# promises must stop here, while the operator is still watching, not hand over a
# host that 500s at first use.
docker build -t minimal-linux-desktop:xfce   "$APP_DIR/images/linux-desktop" \
  || { echo "FATAL: xfce desktop image build failed — aborting deploy (desktops would be unopenable)." >&2; exit 1; }
docker build -t minimal-linux-desktop:icewm  "$APP_DIR/images/icewm-desktop" \
  || { echo "FATAL: icewm desktop image build failed — aborting deploy (desktops would be unopenable)." >&2; exit 1; }
# Selenium node images: pull the public multi-arch seleniarm images, then build
# the kiosk overlay (undecorated, unminimizable, maximized browser windows) and
# tag it to the local names the templates reference, so Chrome/Firefox nodes
# never try to pull a non-existent repo (that was the "VM not creating" 500).
docker pull seleniarm/standalone-chromium:latest && docker build -t local-seleniarm/standalone-chromium:4.5.0-20260701 --build-arg BASE=seleniarm/standalone-chromium:latest "$APP_DIR/images/browser-node" || echo "  WARN: chromium node image unavailable"
docker pull seleniarm/standalone-firefox:latest  && docker build -t local-seleniarm/standalone-firefox:4.5.0-20260701  --build-arg BASE=seleniarm/standalone-firefox:latest  "$APP_DIR/images/browser-node" || echo "  WARN: firefox node image unavailable"

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

echo "[7/8] Starting services…"
systemctl daemon-reload
systemctl enable --now vm-panel.service
systemctl enable --now vm-panel-backup.timer
systemctl start vm-panel-backup.service || true   # take an initial backup now
systemctl restart caddy

# ── Post-deploy verification ────────────────────────────────────────────────────
# A deploy is not finished because systemd returned 0. Prove the thing actually
# serves before telling the operator it is ready: the previous script printed
# DEPLOY_OK unconditionally, so a host with drifted images and a panel that never
# came up still reported success.
echo "[8/8] Verifying the deploy…"
verify_fail=0

# 1. Template images must match what the code proxies to.
if [ -x "$APP_DIR/launchers/verify-images.sh" ] || [ -f "$APP_DIR/launchers/verify-images.sh" ]; then
  if VMP_DOCKER=/usr/bin/docker bash "$APP_DIR/launchers/verify-images.sh"; then
    echo "  images: OK"
  else
    echo "  images: DRIFT — desktops using the drifted template cannot be proxied." >&2
    verify_fail=1
  fi
else
  echo "  images: verify-images.sh not present in this build — skipping (upgrade the release)." >&2
fi

# 2. The panel must answer its own readiness probe (checks docker reachability too).
ready=""
for _ in $(seq 1 30); do
  ready="$(curl -fsS --max-time 3 http://127.0.0.1:5050/readyz 2>/dev/null || true)"
  case "$ready" in *'"ok":true'*) break ;; esac
  sleep 2
done
case "$ready" in
  *'"ok":true'*) echo "  panel: ready ($(echo "$ready" | head -c 120))" ;;
  *)
    echo "  panel: NOT READY after 60s — last response: ${ready:-<none>}" >&2
    echo "         journalctl -u vm-panel -n 50 --no-pager" >&2
    systemctl is-active --quiet vm-panel.service || echo "         vm-panel.service is not active" >&2
    verify_fail=1 ;;
esac

# 3. The public TLS front must terminate and reach the panel.
code="$(curl -fsS -o /dev/null -w '%{http_code}' -k --max-time 8 "https://127.0.0.1:443/healthz" 2>/dev/null || echo 000)"
case "$code" in
  200) echo "  TLS front: OK (https → panel /healthz 200)" ;;
  *)   echo "  TLS front: /healthz via https returned $code — check 'systemctl status caddy'." >&2; verify_fail=1 ;;
esac

echo
if [ "$verify_fail" -ne 0 ]; then
  echo "DEPLOY_FAILED_VERIFICATION — the services are installed but the deploy did NOT pass its checks above." >&2
  echo "Fix the reported problem and re-run; do not hand this host to users yet." >&2
  exit 1
fi

echo "DEPLOY_OK — open https://${PUBLIC_HOST}/ to create the admin account."
echo "TLS cert (self-signed; trust on clients or accept the warning for mic/camera): /etc/caddy/vmpanel.crt"
echo "Acceptance test (optional, creates and destroys one desktop):"
echo "  sudo -u $RUN_USER node $APP_DIR/launchers/e2e-real.mjs"
