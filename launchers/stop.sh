#!/bin/bash
# VM Panel — Stop the panel service. By default the Docker VM and every machine
# stay running so no live session is lost; you are then asked whether to shut the
# VM down as well. Invoked by the "Stop VM Panel" Desktop launcher.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

LABEL="com.vmpanel"
DOMAIN="gui/$(id -u)"

echo "=================================================="
echo "  VM Panel  —  Stop"
echo "=================================================="
echo

echo "[1/2] VM Panel service..."
if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  if launchctl bootout "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
    echo "      Stopped. It will stay down until you run Start again."
  else
    echo "      WARNING: the stop command reported an error. It may still be running."
  fi
else
  echo "      Was not running."
fi
echo

echo "[2/2] Docker VM (Colima) and your machines..."
echo "      Your desktops and nodes are STILL RUNNING inside the Docker VM."
echo "      They are kept up so no running session is lost."
echo
printf "      Also stop the Docker VM, shutting down ALL machines? [y/N] "
read -r ans
case "${ans:-}" in
  y|Y|yes|YES)
    echo "      Stopping the Docker VM..."
    if colima stop >/dev/null 2>&1; then
      echo "      Docker VM stopped. All machines are now off."
    else
      echo "      WARNING: could not stop the Docker VM. Run 'colima stop' in Terminal."
    fi
    ;;
  *)
    echo "      Leaving the Docker VM running. (To stop it later: colima stop)"
    ;;
esac
echo
echo "Done."
sleep 1
exit 0
