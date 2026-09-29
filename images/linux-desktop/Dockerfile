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

# Patch the base image's own packages. kasmweb/core-ubuntu-noble:1.17.0 was last
# pushed 2025-04, so `--pull` alone changes nothing; without this every rebuild
# keeps its 2025 userland (libc, OpenSSL, X libraries). KasmVNC itself is a
# local .deb with no apt repo, so an upgrade cannot replace it.
RUN apt-get update \
  && apt-get -y -o Dpkg::Options::=--force-confold upgrade \
  && rm -rf /var/lib/apt/lists/*

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

# Chromium — Chrome's open-source base (same Blink engine, DevTools, Google
# sign-in). Google Chrome ships amd64-only and cannot run on this arm64 host, and
# Ubuntu's own chromium-browser package is a snap that will not run in a container
# (the same reason Firefox comes from Mozilla's apt repo above). The xtradeb PPA
# provides a real, non-snap arm64 .deb built for Ubuntu Noble. It is launched with
# --no-sandbox because the desktop runs as uid 1000 without CAP_SYS_ADMIN — the
# disposable container is itself the isolation boundary. A PATH-priority wrapper
# plus a patched .desktop entry apply the flags to both the terminal command and
# the application-menu launcher.
RUN apt-get update \
  && apt-get install -y --no-install-recommends software-properties-common \
  && add-apt-repository -y ppa:xtradeb/apps \
  && apt-get update && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/* \
  && printf '#!/bin/bash\nexec /usr/bin/chromium --no-sandbox --disable-gpu --password-store=basic "$@"\n' > /usr/local/bin/chromium \
  && chmod +x /usr/local/bin/chromium \
  && sed -i -E 's#^Exec=/usr/bin/chromium#Exec=/usr/bin/chromium --no-sandbox --disable-gpu --password-store=basic#' /usr/share/applications/chromium.desktop

# OneDrive (Microsoft 365) sync client: abraunegg/onedrive from the upstream-
# recommended OpenSuSE Build Service repository (the Ubuntu universe package is
# 2.4.x, which upstream calls outdated and buggy). Installed, not configured: a
# user signs in with `onedrive` (device code at microsoft.com/devicelogin) and
# syncs to ~/OneDrive; config and tokens live in ~/.config/onedrive, so they
# survive archive + restore onto a newer image. There is no systemd in the
# desktop, so the packaged user unit is dropped.
RUN wget -qO - https://download.opensuse.org/repositories/home:/npreining:/debian-ubuntu-onedrive/xUbuntu_24.04/Release.key | gpg --dearmor > /usr/share/keyrings/obs-onedrive.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/obs-onedrive.gpg] https://download.opensuse.org/repositories/home:/npreining:/debian-ubuntu-onedrive/xUbuntu_24.04/ ./" > /etc/apt/sources.list.d/onedrive.list \
  && apt-get update && apt-get install -y --no-install-recommends --no-install-suggests onedrive \
  && rm -f /etc/systemd/user/default.target.wants/onedrive.service \
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
COPY jsmpeg.min.js prism-audio.js prism-tuning.js prism-mic.js /usr/share/kasmvnc/www/
RUN sed -i 's#</body>#<script src="prism-tuning.js"></script><script src="jsmpeg.min.js"></script><script src="prism-audio.js"></script><script src="prism-mic.js"></script></body>#' /usr/share/kasmvnc/www/vnc.html

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
# NO passwordless sudo.
#
# This image previously granted `kasm-user ALL=(ALL) NOPASSWD:ALL` so apt installs
# would work on a locked account. That turned any code execution inside the
# desktop (a browser renderer bug — Chromium here runs --no-sandbox) into
# container root, and because the daemon does not use user-namespace remapping,
# container root IS VM root, which has read-write access to the host home
# directory over virtiofs — including the panel's data/secret and data/users.json.
#
# The panel now also runs these containers with --security-opt no-new-privileges,
# which blocks setuid binaries from elevating, so sudo cannot function regardless
# of the sudoers file; leaving the rule in place would only be misleading.
#
# Consequence, by design: a contractor cannot install packages inside their
# desktop. Bake anything they need into this image instead. If interactive
# package installs are genuinely required for a use case, the correct fix is to
# enable dockerd userns-remap (so container root is an unprivileged VM uid) and
# drop no-new-privileges for that template — not to restore blanket sudo.

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -sk https://localhost:6901/ -o /dev/null || exit 1

USER 1000
