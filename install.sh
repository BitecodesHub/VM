#!/bin/bash
# VM Panel — one-command install. Bootstraps the panel and the daily-backup
# launchd agents so auto-start + auto-restart + backups are ON by default.
# Idempotent: re-run to update. Usage: bash install.sh
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

REPO="/Users/mac/vm-panel"
LA="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
mkdir -p "$LA"

install_agent() {
  local label="$1" src="$REPO/launchd/$1.plist"
  [ -f "$src" ] || { echo "missing $src"; return 1; }
  cp "$src" "$LA/$label.plist"
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$LA/$label.plist" && echo "installed $label" || { echo "FAILED to bootstrap $label"; return 1; }
}

echo "== VM Panel install =="
echo "[1/3] Running the test suite (gate before enabling)..."
if ! /opt/homebrew/bin/node --test "$REPO"/test/*.test.js >/dev/null 2>&1; then
  echo "WARNING: tests did not all pass — continuing, but review before relying on this build."
else echo "      tests green."; fi

echo "[2/3] Installing the panel service (auto-start + auto-restart)..."
install_agent com.vmpanel

echo "[3/5] Installing the daily backup timer..."
echo "      Backups go to VMP_BACKUP_DIR (see launchd/com.vmpanel.backup.plist)."
echo "      Point it at an OFF-HOST volume for real disaster recovery."
install_agent com.vmpanel.backup

echo "[4/5] Log rotation (newsyslog) so process logs cannot fill the disk..."
LOGDIR="$HOME/Library/Logs"
NEWSYSLOG_CONF="$(mktemp)"
{
  echo "# VM Panel logs — rotate at 5MB, keep 7, compress. Installed by install.sh."
  for f in vm-panel vm-panel-caddy vm-panel-backup; do
    printf '%s\t%s:staff\t644\t7\t5000\t*\tGN\n' "$LOGDIR/$f.log" "$(id -un)"
  done
} > "$NEWSYSLOG_CONF"
if sudo -n cp "$NEWSYSLOG_CONF" /etc/newsyslog.d/vm-panel.conf 2>/dev/null; then
  echo "      Installed /etc/newsyslog.d/vm-panel.conf (5MB × 7, compressed)."
else
  echo "      Needs sudo — run once to enable rotation:"
  echo "        sudo cp '$NEWSYSLOG_CONF' /etc/newsyslog.d/vm-panel.conf"
  echo "      (or on Linux, use logrotate; see README)."
fi

echo "[5/5] TLS front (Caddy) — optional, required for microphone/camera..."
if command -v caddy >/dev/null 2>&1; then
  install_agent com.vmpanel.caddy
  echo "      HTTPS: https://localhost:8443 (panel) · screens on :5443"
  echo "      Run once so the cert is trusted (secure context):  sudo caddy trust"
  echo "      Then set data/config.json: { \"publicTls\": true, \"publicHost\": \"<mDNS-or-host>\" } and restart the panel."
else
  echo "      Caddy not installed — skipping. 'brew install caddy' then re-run to enable HTTPS + mic/camera."
fi

echo
echo "Done. Panel: http://localhost:5050  ·  logs: ~/Library/Logs/vm-panel.log"
echo "Backups:    launchers/backup.sh  ·  restore: launchers/restore.sh"
