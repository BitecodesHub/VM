# Modern, lightweight XFCE desktop for VM Panel — no systemd required.
# Xvfb + dbus-launch + XFCE + x11vnc + noVNC, dark-themed (Arc-Dark + Papirus).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:1

# Core desktop (explicit, --no-install-recommends to skip screensaver/light-locker
# and other systemd-hungry extras that crash in a minimal VM).
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc websockify dbus-x11 \
      xfce4-session xfwm4 xfce4-panel xfce4-settings xfconf xfdesktop4 \
      thunar xfce4-terminal mousepad \
      arc-theme papirus-icon-theme \
      fonts-noto-core fonts-dejavu-core \
      ca-certificates curl wget gnupg sudo x11-xserver-utils \
      imagemagick \
  && rm -rf /var/lib/apt/lists/*

# Real Firefox from Mozilla's apt repo (Ubuntu's "firefox" is a snap, which will
# not run in a container).
RUN install -d -m 0755 /etc/apt/keyrings \
  && wget -q https://packages.mozilla.org/apt/repo-signing-key.gpg -O /etc/apt/keyrings/packages.mozilla.org.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list \
  && printf 'Package: firefox*\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla \
  && apt-get update && apt-get install -y --no-install-recommends firefox \
  && rm -rf /var/lib/apt/lists/*

# Subtle dark gradient wallpaper, then drop imagemagick to keep the image lean.
RUN mkdir -p /usr/share/backgrounds \
  && convert -size 1920x1080 gradient:'#20242e-#0e1014' /usr/share/backgrounds/vmpanel.png \
  && apt-get purge -y imagemagick && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Unprivileged desktop user with passwordless sudo.
RUN useradd -ms /bin/bash linuxuser \
  && echo 'linuxuser ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers \
  && mkdir -p /home/linuxuser/Desktop

# Preseed XFCE theme/icons/wm so the desktop is dark from first paint.
COPY xfconf/ /home/linuxuser/.config/xfce4/xfconf/xfce-perchannel-xml/
RUN chown -R linuxuser:linuxuser /home/linuxuser/.config

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 6080

# Liveness: the noVNC/websockify bridge must answer on 6080. start-period covers
# Xvfb + XFCE + x11vnc coming up; afterwards a wedged desktop shows as
# STATUS=unhealthy in `docker ps` so the panel/ops can spot it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS http://localhost:6080/ >/dev/null || exit 1

USER linuxuser
WORKDIR /home/linuxuser
CMD ["/usr/local/bin/start.sh"]
