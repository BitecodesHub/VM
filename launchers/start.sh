#!/bin/bash
# VM Panel — Start the full stack: the Colima Docker VM (if stopped) plus the
# panel service, then open the panel in the browser. Idempotent: safe to run
# when everything is already up. Invoked by the "Start VM Panel" Desktop launcher.
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
echo "  VM Panel  —  Start"
echo "=================================================="
echo

echo "[1/3] Docker VM (Colima)..."
if colima status >/dev/null 2>&1; then
  echo "      Already running."
else
  echo "      Stopped. Starting it now (a first run can take a minute or two)..."
  # Tolerate a concurrent Start: our own 'colima start' may lose the VM lock to a
  # second launcher, so trust the resulting status, not this command's exit code.
  colima start >/dev/null 2>&1 || true
  colima status >/dev/null 2>&1 || fail "Could not start the Docker VM. Open Terminal and run 'colima start' to see why."
  echo "      Started."
fi
echo

echo "[2/3] VM Panel service..."
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  # Loaded already: (re)start it if it is not up. kickstart on a running
  # service is a no-op, so this never disturbs an active panel.
  launchctl kickstart "${DOMAIN}/${LABEL}" >/dev/null 2>&1
  echo "      Service is loaded and running."
elif [ -f "$PLIST" ]; then
  # bootstrap fails ("service already loaded") if a concurrent Start won the race;
  # that is success for us, so re-check rather than failing on the exit code.
  launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || fail "Could not load the VM Panel service ($PLIST)."
  echo "      Service loaded."
else
  fail "The launchd file is missing: $PLIST"
fi
echo

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
echo "Done. VM Panel is ready."
sleep 1
exit 0
