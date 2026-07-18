# PRISM Virtual Desktop — browser node (Selenium standalone) kiosk overlay.
#
# Derived from the public seleniarm images (deploy-aws.sh builds this overlay
# for BOTH chromium and firefox via --build-arg BASE, tagged to the local-
# seleniarm names the templates reference). Two changes, both so the node's
# screen only ever shows the browser — never the bare Selenium desktop:
#   - fluxbox `apps`: every window is undecorated + maximized. No title bar
#     means no minimize/close buttons to hit by accident (kiosk feel).
#   - fluxbox `keys`: the stock bindings included `Mod1 F9 :Minimize` (and
#     Close/Maximize friends), so the browser could still be minimized from
#     the keyboard. Replaced with an empty set — a kiosk node needs no WM
#     shortcuts at all.
# The panel additionally re-asserts the window rect on every open (server.js
# openBrowserSession), which per W3C RESTORES a minimized window — covering
# the remaining path where a WebDriver script minimizes it.
ARG BASE=seleniarm/standalone-chromium:latest
FROM ${BASE}

USER root
COPY fluxbox-apps /home/seluser/.fluxbox/apps
COPY fluxbox-keys /home/seluser/.fluxbox/keys
RUN chown seluser:seluser /home/seluser/.fluxbox/apps /home/seluser/.fluxbox/keys

LABEL vmpanel.image="browser-node-kiosk"

USER 1200
