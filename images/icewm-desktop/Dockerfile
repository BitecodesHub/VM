# PRISM Virtual Desktop — IceWM lightweight desktop (tag: minimal-linux-desktop:icewm).
#
# Same KasmVNC base as the XFCE desktop (so speaker/microphone/camera work by
# default), but swaps the heavy XFCE session for lightweight IceWM. KasmVNC's
# start_window_manager honours START_XFCE4=0 (skip XFCE) and its main flow calls
# custom_startup (verified: vnc_startup.sh line ~574), which we point at IceWM.
FROM kasmweb/core-ubuntu-noble:1.17.0

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      icewm xterm \
      pulseaudio-utils alsa-utils pavucontrol \
      v4l-utils ffmpeg \
      ca-certificates wget curl \
  && rm -rf /var/lib/apt/lists/*

# Real Firefox from Mozilla's apt repo (Ubuntu's "firefox" is a snap).
RUN install -d -m 0755 /etc/apt/keyrings \
  && wget -q https://packages.mozilla.org/apt/repo-signing-key.gpg -O /etc/apt/keyrings/packages.mozilla.org.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list \
  && printf 'Package: firefox*\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla \
  && apt-get update && apt-get install -y --no-install-recommends firefox \
  && rm -rf /var/lib/apt/lists/*

# Disable the base image's XFCE and launch IceWM via KasmVNC's custom_startup hook.
ENV START_XFCE4=0
RUN printf '#!/usr/bin/env bash\nexport DISPLAY=:1\nexec /usr/bin/icewm-session\n' > /dockerstartup/custom_startup.sh \
  && chmod +x /dockerstartup/custom_startup.sh

LABEL vmpanel.image="linux-desktop-icewm"

RUN mkdir -p /home/kasm-user/Uploads && chown -R 1000:1000 /home/kasm-user/Uploads

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -sk https://localhost:6901/ -o /dev/null || exit 1

USER 1000
