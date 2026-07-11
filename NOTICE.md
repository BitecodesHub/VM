# NOTICE — third-party software in VM Panel machine images

The VM Panel application itself has **no runtime npm dependencies** (Node.js
built-ins only). The machine *images* it launches bundle third-party software,
all under permissive/open-source licences and redistributable:

## Linux Desktop images (`images/linux-desktop/`)
- **Ubuntu 24.04** base — various OSS licences.
- **XFCE** desktop environment — GPLv2 / LGPLv2.
- **IceWM** window manager (lightweight image) — LGPLv2.
- **Mozilla Firefox** — MPL 2.0, installed from Mozilla's official apt repository.
- **Arc theme** (GPLv3), **Papirus icons** (GPLv3), **Noto / DejaVu fonts** (OFL / permissive).
- **x11vnc**, **Xvfb**, **noVNC / websockify** — GPLv2 / MPL / permissive.

## Browser test nodes
- **Selenium** standalone Chromium / Firefox images (`local-seleniarm/*`) — Apache-2.0
  (Selenium) plus the browsers' own licences. Chromium is the open-source project,
  not Google Chrome branding.

Trademarks (Firefox, Chromium, Ubuntu, XFCE, etc.) belong to their respective
owners. This project bundles these tools for internal use; verify licence terms
before any external distribution or commercial redistribution of the images.
