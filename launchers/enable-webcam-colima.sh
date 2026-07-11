#!/bin/bash
# VM Panel — enable the webcam for Media Desktops on THIS Mac (Colima).
#
# ⚠️  BEST-EFFORT / FRAGILE. Audio (speaker + microphone) works with no setup.
# The *camera* needs a virtual video device (v4l2loopback) inside the Colima VM,
# and that VM's stock kernel does NOT ship the module — this script builds it
# with dkms inside the VM. It can fail if the VM lacks matching kernel headers,
# and it must be re-run after a Colima VM rebuild. On a real Linux/EC2 host the
# camera works out of the box (see deploy/cloud-init.yaml) — this hack is only
# for local Mac testing.
#
# After a successful run, tell the panel the host now has a camera:
#   1) add   "hostWebcam": true   to data/config.json
#   2) restart the panel (launchers/restart.sh)
# Existing Media Desktops must be re-created to pick up the --device mapping.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

say() { echo "  $*"; }
fail() { echo; echo "ERROR: $1"; echo; exit 1; }

echo "=================================================="
echo "  VM Panel  —  Enable webcam (Colima, best-effort)"
echo "=================================================="
echo

command -v colima >/dev/null 2>&1 || fail "colima not found on PATH."
colima status >/dev/null 2>&1 || fail "Colima VM is not running. Start it first (launchers/start.sh)."

say "[1/4] Installing build tools + v4l2loopback-dkms inside the VM..."
# The Colima VM is Ubuntu-based; build the module against the running kernel.
colima ssh -- sudo bash -c '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq linux-headers-$(uname -r) v4l2loopback-dkms v4l2loopback-utils
' || fail "Package install/build failed. The VM kernel may lack matching headers (linux-headers-$(colima ssh -- uname -r 2>/dev/null))."

say "[2/4] Loading the v4l2loopback module (creates /dev/video0)..."
colima ssh -- sudo modprobe v4l2loopback devices=1 video_nr=0 card_label=VMPanelCam exclusive_caps=1 \
  || fail "modprobe v4l2loopback failed. Run 'colima ssh -- dmesg | tail' to see why."
# The node is root:video 0660; the KasmVNC container runs as uid 1000 (not in the
# host video group), so make it world-accessible or the desktop cannot open it.
colima ssh -- sudo chmod 0666 /dev/video0 || say "  (could not chmod /dev/video0; camera may be unreadable inside the container)"

say "[3/4] Making it load on VM boot..."
colima ssh -- sudo bash -c 'echo v4l2loopback > /etc/modules-load.d/v4l2loopback.conf; \
  echo "options v4l2loopback devices=1 video_nr=0 card_label=VMPanelCam exclusive_caps=1" > /etc/modprobe.d/v4l2loopback.conf' \
  || say "  (could not persist boot-load; module is loaded for this session only)"

say "[4/4] Verifying /dev/video0 exists in the VM..."
if colima ssh -- test -e /dev/video0; then
  say "  /dev/video0 is present. ✅"
  echo
  echo "Next steps:"
  echo "  • Set  \"hostWebcam\": true  in data/config.json"
  echo "  • Restart the panel:  launchers/restart.sh"
  echo "  • Re-create any Media Desktop so it maps the camera device."
  exit 0
else
  fail "/dev/video0 did not appear. Webcam stays unavailable; audio still works."
fi
