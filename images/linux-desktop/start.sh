#!/bin/bash
set -e
export DISPLAY=:1
export HOME=/home/linuxuser

# Clear stale X locks so the display can be reused after a container restart.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

# Virtual display.
Xvfb :1 -screen 0 1440x900x24 -nolisten tcp -ac &
for i in $(seq 1 40); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.2; done

# Session bus (no systemd — dbus-launch provides the session bus XFCE needs).
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

# Start the XFCE session (window manager, panel, desktop, settings daemon).
startxfce4 &
sleep 5

# Apply the dark wallpaper across whatever monitor node xfdesktop created.
WALL=/usr/share/backgrounds/vmpanel.png
xfconf-query -c xfce4-desktop -l 2>/dev/null | grep -E '/last-image$' | while read -r prop; do
  base="${prop%/last-image}"
  xfconf-query -c xfce4-desktop -p "$base/last-image" -s "$WALL" 2>/dev/null || true
  xfconf-query -c xfce4-desktop -p "$base/image-style" -s 5 2>/dev/null || true
done
xfconf-query -c xfce4-desktop -p /backdrop/screen0/monitorscreen/workspace0/last-image -n -t string -s "$WALL" 2>/dev/null || true
xfconf-query -c xfce4-desktop -p /backdrop/screen0/monitorscreen/workspace0/image-style -n -t int -s 5 2>/dev/null || true

# VNC server + noVNC bridge (password "secret", loopback only — the panel proxies).
mkdir -p "$HOME/.vnc"
[ -f "$HOME/.vnc/passwd" ] || x11vnc -storepasswd secret "$HOME/.vnc/passwd"

# Supervise x11vnc: if it ever crashes (X hiccup, client storm) restart it so the
# screen self-heals instead of leaving a live websockify pointed at a dead VNC.
# The log is capped first each pass so a restart loop can never fill the layer.
VNCLOG="$HOME/.vnc/x11vnc.log"
supervise_x11vnc() {
  while true; do
    if [ -f "$VNCLOG" ] && [ "$(stat -c%s "$VNCLOG" 2>/dev/null || echo 0)" -gt 5242880 ]; then
      : > "$VNCLOG"
    fi
    x11vnc -display :1 -forever -shared -rfbauth "$HOME/.vnc/passwd" \
      -rfbport 5900 -localhost -o "$VNCLOG" >>"$VNCLOG" 2>&1 || true
    echo "[start.sh] x11vnc exited ($(date -u +%H:%M:%S)); restarting in 2s" >> "$VNCLOG"
    sleep 2
  done
}
supervise_x11vnc &

# noVNC bridge is PID 1: it stays foreground so the container's lifecycle tracks
# the thing users actually connect to. It reconnects to 5900 as x11vnc recovers.
exec websockify --web=/usr/share/novnc 6080 localhost:5900
