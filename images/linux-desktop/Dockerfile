# PRISM Virtual Desktop — XFCE desktop (image tag: minimal-linux-desktop:xfce).
#
# Built on KasmVNC (kasmweb) so speaker, microphone AND camera work by DEFAULT.
# Plain VNC (x11vnc + noVNC) carries only pixels+input and CANNOT do audio, so
# every desktop now uses KasmVNC: its web client streams desktop audio OUT, pipes
# the browser microphone IN to a PulseAudio virtual source, and (when the host
# provides a v4l2loopback /dev/video0) feeds the browser camera into the desktop.
# It all rides ONE HTTPS port with Basic auth, which the panel proxies under
# /m/<name>/ and satisfies server-side (see lib/core.js linux-desktop template).
# XFCE is the KasmVNC base image's built-in desktop environment.
FROM kasmweb/core-ubuntu-noble:1.17.0

USER root
ENV DEBIAN_FRONTEND=noninteractive
# GPU-less cloud host: force Mesa software GL so apps (Firefox) don't loop on
# failed hardware/zink init.
ENV LIBGL_ALWAYS_SOFTWARE=1

# Apps that make the media devices usable + verifiable.
RUN apt-get update && apt-get install -y --no-install-recommends \
      pulseaudio-utils alsa-utils pavucontrol \
      v4l-utils ffmpeg \
      ca-certificates wget curl \
  && rm -rf /var/lib/apt/lists/*

# Real Firefox from Mozilla's apt repo (Ubuntu's "firefox" is a snap that will
# not run in a container).
RUN install -d -m 0755 /etc/apt/keyrings \
  && wget -q https://packages.mozilla.org/apt/repo-signing-key.gpg -O /etc/apt/keyrings/packages.mozilla.org.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list \
  && printf 'Package: firefox*\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla \
  && apt-get update && apt-get install -y --no-install-recommends firefox \
  && rm -rf /var/lib/apt/lists/*

# Rebrand the KasmVNC web client so it never shows "Kasm" to users: retitle,
# replace the visible product name with PRISM, and blank the Kasm logo/favicon
# assets. Only display strings + images are touched — internal identifiers and
# the kasm_audio/websockify paths (not user-visible) are left intact.
RUN set -e; cd /usr/share/kasmvnc/www \
 && sed -i 's#<title>KasmVNC</title>#<title>PRISM Virtual Desktop</title>#g' index.html vnc.html \
 && for f in index.html vnc.html main.bundle.js screen.bundle.js; do [ -f "$f" ] && sed -i 's/KasmVNC/PRISM/g' "$f" || true; done \
 && printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC' | base64 -d > /tmp/blank.png \
 && for f in assets/*kasm*logo*.png; do cp /tmp/blank.png "$f"; done \
 && rm -f /tmp/blank.png \
 && printf '%s' ';try{(function(){var T="PRISM Virtual Desktop";function f(){try{if(document.title!==T)document.title=T}catch(e){}}f();setInterval(f,700)})()}catch(e){}' >> main.bundle.js

# Desktop speaker audio. The OSS KasmVNC client does not play desktop audio
# itself (it delegates to the paid Workspaces parent), so bundle a jsmpeg player
# that decodes the panel-proxied audio-out stream (/m/<name>/kasmaudio). Decoding
# is client-side, so the server only relays bytes.
COPY jsmpeg.min.js prism-audio.js prism-tuning.js /usr/share/kasmvnc/www/
RUN sed -i 's#</body>#<script src="prism-tuning.js"></script><script src="jsmpeg.min.js"></script><script src="prism-audio.js"></script></body>#' /usr/share/kasmvnc/www/vnc.html

LABEL vmpanel.image="linux-desktop-xfce"

# Uploads dir + fix home ownership. Root-run build steps (wget/apt) leak
# root-owned dirs into /home/kasm-user (e.g. .cache 700 root), which blocks the
# desktop user (uid 1000) from creating its Firefox profile → "Profile Missing".
# Own the WHOLE home as uid 1000 so apps work.
RUN mkdir -p /home/kasm-user/Uploads \
 && rm -rf /home/kasm-user/.cache /home/kasm-user/.wget-hsts \
 && chown -R 1000:1000 /home/kasm-user

# Pre-create a default Firefox profile so it never shows "Profile Missing" /
# the Profile Manager on first launch (auto-creation is unreliable under the
# software-GL headless X).
RUN mkdir -p /home/kasm-user/.mozilla/firefox/prism.default \
 && printf '[Profile0]\nName=default\nIsRelative=1\nPath=prism.default\nDefault=1\n\n[General]\nStartWithLastProfile=1\nVersion=2\n' > /home/kasm-user/.mozilla/firefox/profiles.ini \
 && printf 'user_pref("gfx.webrender.software", true);\nuser_pref("gfx.canvas.accelerated", false);\nuser_pref("layers.acceleration.disabled", true);\nuser_pref("webgl.disabled", true);\nuser_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("datareporting.policy.dataSubmissionEnabled", false);\nuser_pref("browser.aboutwelcome.enabled", false);\nuser_pref("toolkit.telemetry.reportingpolicy.firstRun", false);\n' > /home/kasm-user/.mozilla/firefox/prism.default/user.js \
 && chown -R 1000:1000 /home/kasm-user/.mozilla

# Liveness: KasmVNC serves HTTPS on 6901 (answers 401 until Basic auth, which
# still proves it is up — so any response is success, no response is wedged).
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -sk https://localhost:6901/ -o /dev/null || exit 1

USER 1000
