#!/bin/bash
# VM Panel — Restart the panel service (ensuring the Docker VM is up first), then
# reopen the panel. This cycles the panel process only; the Docker VM and running
# machines are left alone. Invoked by the "Restart VM Panel" Desktop launcher.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LABEL="com.vmpanel"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PANEL_URL="http://localhost:5050"

fail() {
  echo
  echo "ERROR: $1"
  echo
  read -n1 -rsp "Press any key to close this window..."
  echo
  exit 1
}

echo "=================================================="
echo "  VM Panel  —  Restart"
echo "=================================================="
echo

echo "[1/3] Docker VM (Colima)..."
if colima status >/dev/null 2>&1; then
  echo "      Running."
else
  echo "      Stopped. Starting it now (a first run can take a minute or two)..."
  # Trust the resulting status, not the exit code (a concurrent launcher may hold
  # the VM lock and make our own 'colima start' return non-zero even on success).
  colima start >/dev/null 2>&1 || true
  colima status >/dev/null 2>&1 || fail "Could not start the Docker VM. Open Terminal and run 'colima start' to see why."
  echo "      Started."
fi
echo

echo "[2/3] Restarting the VM Panel service..."
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl kickstart -k "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || fail "Could not restart the VM Panel service."
  echo "      Restarted."
elif [ -f "$PLIST" ]; then
  # A concurrent launcher may have loaded it first; re-check instead of failing.
  launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || fail "Could not load the VM Panel service ($PLIST)."
  echo "      Loaded."
else
  fail "The launchd file is missing: $PLIST"
fi
echo
# Let the SIGKILL/rebind from kickstart -k settle so the readiness probe below
# tests the freshly-launched process, not the one that is being torn down.
sleep 1

echo "[3/3] Waiting for the panel to answer..."
ready=""
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:5050/api/me" 2>/dev/null || echo 000)
  case "$code" in
    200|401|409) ready="$code"; break ;;
  esac
  sleep 1
done
[ -n "$ready" ] || fail "The panel did not become ready within 30 seconds. Log: ~/Library/Logs/vm-panel.log"
echo "      Panel is up (HTTP $ready)."
echo
echo "Opening ${PANEL_URL}"
[ -n "${VMP_NO_OPEN:-}" ] || open "$PANEL_URL"
echo
echo "Done. VM Panel has been restarted."
sleep 1
exit 0
