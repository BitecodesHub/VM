# PRISM Virtual Desktop — browser node (Selenium standalone) kiosk overlay.
#
# Derived from the official multi-arch Selenium image (linux/arm64 included),
# pinned to a dated tag so a rebuild is reproducible; deploy-aws.sh builds it
# and tags it to the local name the chrome-node template references. The
# seleniarm images this used to derive from stopped updating in 2024
# (Chromium 124). Two changes, both so the node's screen only ever shows the
# browser — never the bare Selenium desktop:
#   - fluxbox `apps`: every window is undecorated + maximized. No title bar
#     means no minimize/close buttons to hit by accident (kiosk feel).
#   - fluxbox `keys`: the stock bindings included `Mod1 F9 :Minimize` (and
#     Close/Maximize friends), so the browser could still be minimized from
#     the keyboard. Replaced with an empty set — a kiosk node needs no WM
#     shortcuts at all.
#   - fluxbox `init`: the image's defaults with the toolbar hidden.
# fluxbox copies only the files that are missing into ~/.fluxbox on its first
# start, so these survive and the rest come from /etc/X11/fluxbox.
# The panel additionally maximizes the window on every open (server.js
# openBrowserSession), which per W3C RESTORES a minimized window — covering
# the remaining path where a WebDriver script minimizes it.
ARG BASE=selenium/standalone-chromium:4.49.0-20260909
FROM ${BASE}

USER root
COPY fluxbox-apps /home/seluser/.fluxbox/apps
COPY fluxbox-keys /home/seluser/.fluxbox/keys
# The image's own fluxbox defaults, with the bottom toolbar (clock, workspace
# switcher) hidden so a maximized browser fills the whole 1920x1080 screen.
RUN cp /etc/X11/fluxbox/init /home/seluser/.fluxbox/init \
 && sed -i '/^session\.screen0\.toolbar\.visible:/d' /home/seluser/.fluxbox/init \
 && printf '\nsession.screen0.toolbar.visible: false\n' >> /home/seluser/.fluxbox/init \
 && chown -R seluser:seluser /home/seluser/.fluxbox

LABEL vmpanel.image="browser-node-kiosk"

USER 1200
