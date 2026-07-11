# VM Panel — Media Desktop. A browser desktop where speaker, microphone and
# webcam actually work (unlike the VNC desktops, which carry only pixels+input).
#
# Built on KasmVNC (kasmweb): its web client streams desktop audio OUT, pipes the
# browser microphone IN to a PulseAudio virtual source, and (on a host that
# provides a v4l2loopback /dev/video0) feeds the browser camera into the desktop.
# All of it rides ONE HTTPS port with Basic auth, which the panel proxies under
# /m/<name>/ and satisfies server-side (see lib/core.js media-desktop template).
#
# This layer only ADDS the apps that make those devices usable + verifiable:
#   • Firefox            — a real browser to use mic/cam in web apps (meetings…)
#   • pulseaudio-utils   — paplay/parec to prove speaker + mic
#   • alsa-utils         — aplay/arecord fallback
#   • pavucontrol        — GUI mixer to see the virtual sink/source
#   • v4l-utils, ffmpeg  — v4l2-ctl / ffplay to prove /dev/video0 (webcam host)
# The kasmweb ENTRYPOINT/CMD and kasm-user (uid 1000) are inherited unchanged.
FROM kasmweb/core-ubuntu-noble:1.17.0

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      pulseaudio-utils alsa-utils pavucontrol \
      v4l-utils ffmpeg \
      ca-certificates wget curl \
  && rm -rf /var/lib/apt/lists/*

# Real Firefox from Mozilla's apt repo (Ubuntu's "firefox" is a snap that will
# not run in a container) — same approach as the XFCE desktop image.
RUN install -d -m 0755 /etc/apt/keyrings \
  && wget -q https://packages.mozilla.org/apt/repo-signing-key.gpg -O /etc/apt/keyrings/packages.mozilla.org.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list \
  && printf 'Package: firefox*\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla \
  && apt-get update && apt-get install -y --no-install-recommends firefox \
  && rm -rf /var/lib/apt/lists/*

LABEL vmpanel.image="media-desktop"

# Uploads dir exists in the base image; ensure it (kasm-user is uid/gid 1000).
RUN mkdir -p /home/kasm-user/Uploads && chown -R 1000:1000 /home/kasm-user/Uploads

# Liveness: KasmVNC must be serving HTTPS on 6901. It answers 401 until Basic
# auth, which still proves it is up — so DON'T use curl -f (that fails on 401);
# a bare response (any status) is success, no response is a wedged desktop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -sk https://localhost:6901/ -o /dev/null || exit 1

USER 1000
