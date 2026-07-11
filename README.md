# PRISM Virtual Desktop

*(internal codename: VM Panel — the `com.vmpanel` service, `vmpanel.*` labels, and
`vmp_session` cookie keep that name for stability.)*

A local, multi-user admin panel for the Colima VM and its Docker "machines"
(Linux desktops, a media desktop with audio/mic/camera, and Chrome/Firefox
Selenium nodes). One password-protected URL where users log in, create machines,
and use their live screens right in the browser. Zero npm dependencies — Node
v20 built-ins only.

## Access — one URL from any PC on your network

**http://macs-macbook-pro.local:5050**

This mDNS hostname is stable: it keeps working even if the Mac's IP address
changes, so it is the recommended URL to share. It resolves on Windows 10/11,
macOS, and Linux out of the box. (Some Android phones do not resolve `.local`
names — on those, use the numeric address below.)

Also valid:
- **On this Mac:** http://127.0.0.1:5050 or http://localhost:5050
- **By IP from the LAN:** http://192.168.1.102:5050

The panel listens dual-stack (IPv4 + IPv6) on port 5050. A double-click launcher
**"Open VM Panel.command"** is in this folder and on the Desktop.

### Pinning the IP address (optional static IP)

The hostname URL above already survives IP changes, so a static IP is usually
unnecessary. If you still want the numeric address fixed, the safe way is a
**DHCP reservation on your router** (this does not risk address conflicts the way
a manually-set static IP does):

1. Open your router admin page (gateway `rtk_gw.bbrouter`).
2. Find DHCP / LAN settings → Address Reservation.
3. Reserve IP **192.168.1.102** for this Mac's Wi-Fi MAC **4e:8f:c1:5c:85:8a**
   (interface `en0`).
4. Save. The Mac will always get `192.168.1.102`, so
   `http://192.168.1.102:5050` becomes permanent too.

If you set `lanHost` in `data/config.json` to a different name or a fixed IP, the
panel will display and accept that instead.

## First run

Open the panel and create your **admin account** (username + password, min 10
chars). After that:

- **Admins** get five tabs: My machines, All machines (with owner badges +
  per-machine **Manage access**), **Resources** (capacity + per-machine usage
  across every user), Users (create/reset-password/disable/role/delete), and
  System (start/stop the VM).
- **Regular users** get two tabs: My machines and **Resources** (their own usage
  + overall free capacity — never other users' names). They can create up to
  **2 running** at a time and cannot control the VM or other users.

The **Resources** tab updates live (~2.5s, in place) while it is open and the tab
is focused; it pauses when hidden or navigated away. The underlying Docker stats
are cached ~5s server-side, so the numbers move about every 5s.

Admins create user accounts (there is no self-registration). New users get a
one-time password shown once and must change it on first login.

### Creating a machine

Five templates, chosen at create time:

| Template | Image | Memory cap |
|----------|-------|-----------|
| Linux Desktop — Modern (XFCE) *(recommended)* | `minimal-linux-desktop:xfce` | 1.5 GiB |
| Linux Desktop — Lightweight (IceWM) | `minimal-linux-desktop:icewm` | 1 GiB |
| Linux Desktop — Media (audio + camera) | `minimal-media-desktop:xfce` | 2 GiB |
| Chrome Node (Selenium) | `local-seleniarm/standalone-chromium` | 2 GiB |
| Firefox Node (Selenium) | `local-seleniarm/standalone-firefox` | 2 GiB |

Memory caps apply **only when a machine is capped** (see "shared by default" below).
The **Resources** tab shows a ≥ 80 % warning when the VM is oversubscribed.

Creating is a **two-step flow**: pick a category (Linux Desktop / Browser Node),
then the specific type (XFCE, IceWM or Media; Chrome or Firefox). **Admins** additionally
get to **name** the machine (optional — blank auto-names), **assign viewers** who
may open/use it (not delete), and tick **Cap CPU & memory** for that machine.
The creator stays the owner. Regular users get the same picker with a one-click
Create.

**CPU and memory are shared by default** — machines oversubscribe the host and
burst into idle capacity. Ticking "Cap" (or `capResources: true`) gives that
machine hard `--memory`/`--cpus` limits instead; capped machines show a **capped**
badge. Admins see a **Usage** tab: machine-hours per user plus a live
memory/CPU/disk summary and a recent-memory sparkline.

### Chrome / Firefox nodes (Selenium)

The browser nodes are Selenium test machines. Their screens autoconnect just
like the desktops (no password prompt). By design the screen is an **empty
desktop until a browser is running** — two ways to get one:

- **Open browser** on the card starts a real Chrome/Firefox window on the
  node's screen for manual use. The panel keeps the session alive while it is
  open (Selenium reaps idle sessions after ~5 minutes; the panel pings it every
  2 minutes). **Close browser** ends it. If the panel restarts, live sessions
  stop being pinged and Selenium closes them after the idle timeout.
- **WebDriver tests**: point your test runner at the node's copyable
  WebDriver URL shown on the card (`http://<host>:<port>`, browserName
  `chrome` / `firefox`). With `exposeWebdriver: 'lan'` in `data/config.json`,
  NEW nodes publish this port on the LAN so other PCs can run tests against
  them; existing nodes keep their original binding until recreated.

### Media Desktop (speaker + microphone + camera)

The plain VNC desktops carry only pixels + keyboard/mouse — **no audio, no
camera**. The **Media Desktop** template fixes that: it runs
[KasmVNC](https://www.kasmweb.com/kasmvnc) instead of x11vnc/noVNC, streaming
**desktop audio out**, piping the **browser microphone in**, and (on a host with
a camera device) feeding the **browser webcam** into the desktop. It ships with
Firefox plus `pavucontrol` / `arecord` / `v4l2-ctl` / `ffplay` so the devices are
usable and testable. All of it rides the panel's normal `/m/<name>/` proxy — the
panel speaks TLS to KasmVNC and satisfies its Basic auth **server-side**, so the
embedded screen never shows a login prompt.

Two requirements:

- **HTTPS is mandatory for mic/camera.** Browsers only grant `getUserMedia` in a
  *secure context*. Open the panel through the Caddy TLS front (see
  [HTTPS](#https-tls-front-via-caddy--required-for-microphonecamera)) — the Create
  dialog warns you if the current page is plain HTTP. Speaker (audio-out) works
  over HTTP too; only mic + camera need HTTPS.
- **The camera needs a host video device.** Audio + mic need nothing extra. The
  webcam is mapped in with `--device /dev/video0` **only when the host provides a
  `v4l2loopback` device**. On a Linux/EC2 host that is provisioned automatically
  (`deploy/cloud-init.yaml`); on this Mac's Colima VM the module is absent, so the
  card shows *"mic · speaker (no camera on host)"* and only the camera degrades —
  run `launchers/enable-webcam-colima.sh` (best-effort) and set
  `"hostWebcam": true` to try enabling it.

When you open the desktop the browser asks to use the microphone and camera —
allow it. The card carries a **mic · speaker · camera** badge reflecting what the
host actually supports.

### Files, reconnect & session persistence

- **Files** button on a running machine: upload (≤200 MB) and download files via
  `docker cp` into the machine's upload dir (desktops → `~/Desktop`, nodes →
  `~/Downloads`). Filenames are basename-only and charset-restricted; commands run
  through `execFile` arrays (no shell).
- **Screens auto-reconnect** — the noVNC viewer reconnects on a dropped connection
  (`reconnect=true`), so a brief network blip or panel restart re-attaches the
  screen automatically.
- **Live browser sessions survive a panel restart** — Open-browser sessions are
  persisted and re-attached on boot if the WebDriver still holds them.

### Sharing

Admins can grant per-machine access via **Manage access**. Listed users see the
machine (with a “shared by …” badge) and can open/start/stop/restart/view
logs+stats — but **cannot delete** it (owner or admin only). The access list lives
in `data/machines.json`; labels are immutable so sharing is stored separately.

## How it works

- The panel binds `::` (dual-stack IPv4+IPv6) on port 5050. Every machine's UI stays bound to `127.0.0.1`
  inside the VM and is reached **only** through the panel's authenticated reverse
  proxy at `/m/<name>/…` (HTTP + WebSocket). Machines are never directly
  reachable from the LAN.
- **Machine screens are served on a second port (`5051` = panel port + 1) = a
  separate browser origin.** You still only ever type the `:5050` URL; the panel
  embeds each screen from `:5051`. This isolation means container-controlled page
  content cannot ride the panel's cookie to call `/api/*` (cross-origin ⇒ the Lax
  cookie is withheld and the Origin guard rejects it). Screens carry a CSP
  `frame-ancestors` scoped to exactly the panel origin, so only the panel may
  frame them.
- Ownership rides on a `vmpanel.owner` Docker label; sharing rides on
  `data/machines.json`. Only panel-managed containers are ever shown — non-panel
  containers are hidden from everyone, admins included.
- Sessions are HMAC-signed HttpOnly cookies (7-day sliding). Passwords are scrypt
  hashed. Login is rate-limited. A user's live screen tunnels are cut the moment
  they are disabled, deleted, or have their password reset.

## Trust model

Plain **HTTP on a trusted LAN** — passwords and sessions are not encrypted in
transit. Use only on a network you trust. Do not expose port 5050 to the
internet. The session cookie is intentionally **not** marked `Secure` (there is
no TLS to require); this is an accepted trade-off of the HTTP-on-LAN model, not
an oversight. Moving off a trusted LAN would mean fronting the panel with TLS
(e.g. a Caddy reverse proxy) and setting the cookie `Secure`.

## Configuration — `data/config.json`

| Key | Default | Meaning |
|-----|---------|---------|
| `bind` | `::` | Listen address, dual-stack (use `127.0.0.1` for this-Mac-only) |
| `lanHost` | `macs-macbook-pro.local` | Hostname the panel advertises + accepts |
| `port` | `5050` | Panel port (machine screens are served on `port + 1`) |
| `exposeWebdriver` | `local` | `lan` publishes new Selenium 4444 ports on the LAN for remote WebDriver clients |
| `maxUpgradedSockets` | `64` | Max concurrent live screens |
| `idleStopMinutes` | `0` | Auto-stop a desktop with no open screen for this long (0 = off; set e.g. `60` to reclaim idle capacity) |
| `capResources` | `false` | Default resource mode. `false` = CPU/RAM **shared** (oversubscribed, machines burst into free capacity); `true` = apply per-template hard caps by default. Admins can override per machine at create time |
| `metricsToken` | `null` | Bearer token for `GET /metrics` (≥8 chars). Null = require an admin session |
| `alertWebhook` | `null` | POST `{text}` here when a **critical** alert first fires (Slack/webhook URL) |
| `hostWebcam` | `null` | Media Desktop camera. `null` = auto-detect a host `/dev/video0`; `true`/`false` = explicit override (set `true` on Colima after `launchers/enable-webcam-colima.sh`) |
| `publicTls` | `false` | When served behind the Caddy HTTPS front: accept the public HTTPS origin in the CSRF/Origin + CSP guards, emit `https://` screen URLs, and mark the session cookie **`Secure`** |
| `publicHost` | `null` | The public hostname on the TLS cert (e.g. `macs-macbook-pro.local`) |
| `panelHttpsPort` / `machineHttpsPort` | `8443` / `5443` | HTTPS ports Caddy fronts the panel and machine-screen origins on |
| `actionRateLimit` | `60` | Max expensive machine/VM actions (create/lifecycle/upload) per user per minute before `429` |
| `sessionMaxDays` | `30` | Absolute session lifetime cap (0 = off) — forces periodic re-login even for always-active users |
| `sessionIdleHours` | `0` | Expire a session after this much inactivity (0 = rely on the 7-day sliding TTL) |
| `maxRunningMachines` | `0` | System-wide ceiling on concurrently-running machines across **all** users (0 = unlimited). Protects a shared-by-default host from oversubscription |

### Production hardening (built in)

- **Security:** session cookie is `Secure` under `publicTls`; a strict **Content-Security-Policy** on the app shell (`script-src 'self'`, `frame-src` scoped to the machine origin); raw `docker` stderr is shown only to admins; per-user rate limit on expensive actions.
- **Reliability:** `/api/state` serves a 5-second single-flight cache (no per-poll docker storm); a corrupt store or uncaught error is tagged `[VMP_FATAL]` **and** POSTed to `alertWebhook` so a launchd crash-loop is never invisible; shutdown awaits pending flushes; stale upload temp files are swept at boot; `newsyslog` rotation is installed for the process logs.
- **Alerts:** the metrics engine also flags **unhealthy** containers and a **stale backup** (no successful run in 48h), on top of VM-down / memory / disk.
- **Audit:** every privileged action (sign-in success/failure, user create/update/delete, machine create/delete, sharing, VM control) is appended to `data/audit.jsonl` and shown, newest-first, in the admin **Audit** tab (`GET /api/audit`, admin-only).

Machines also run with a per-container **CPU cap** (`--cpus`, 2 each) alongside the
memory cap, and the panel keeps a **usage ledger** (machine-minutes per user,
admin-visible at `GET /api/usage`). Idle auto-stop only stops desktops with **no
open screen connection** past the threshold — a machine you are viewing is never
stopped, and browser nodes are governed by their own session lifecycle instead.

Restart after editing: `launchctl kickstart -k gui/$(id -u)/com.vmpanel`.

## Run / manage

```sh
# Foreground (dev):
/opt/homebrew/bin/node /Users/mac/vm-panel/server.js
# Tests:
/opt/homebrew/bin/node --test
```

Auto-start at login is installed as a launchd agent (`com.vmpanel`):

```sh
# Stop permanently:  launchctl bootout gui/$(id -u)/com.vmpanel
# Start / reload:    launchctl kickstart -k gui/$(id -u)/com.vmpanel
```

macOS will prompt once to allow incoming network connections for `node` — click
**Allow** so other devices can reach the panel.

### One-click Desktop launchers

Three double-click launchers on the macOS Desktop drive the whole stack without a
terminal — the logic lives in `launchers/` and each Desktop `.command` is a thin
wrapper that runs it:

| Desktop file | Script | Action |
|--------------|--------|--------|
| `Start VM Panel.command` | `launchers/start.sh` | Starts the Colima VM if stopped, ensures the panel is up, then opens it. Idempotent — a no-op if already running. |
| `Restart VM Panel.command` | `launchers/restart.sh` | Ensures the VM is up, then cycles the panel process only (VM + machines untouched). |
| `Stop VM Panel.command` | `launchers/stop.sh` | Stops the panel (`launchctl bootout`) and asks whether to shut the VM (and all machines) down too. Defaults to keeping them running. |

Set `VMP_NO_OPEN=1` to suppress the browser open (used by tests). The launchers
depend on the `com.vmpanel` launchd agent being installed.

## Break-glass

- Forgot the admin password / locked out: stop the panel, delete
  `data/users.json` (and `data/sessions.json`), restart — the panel returns to
  first-run so you can create a fresh admin. Existing machines are untouched.
- Sign everyone out: delete `data/secret` and restart.

## Install (auto-start + auto-restart + backups, on by default)

```sh
bash /Users/mac/vm-panel/install.sh
```

This gates on the test suite, then bootstraps two launchd agents: **`com.vmpanel`**
(auto-start at login, auto-restart on crash) and **`com.vmpanel.backup`** (daily
data backup). Re-run any time to update.

## Backups & restore

The only stateful files live in `data/`: `users.json` (accounts), `secret`
(cookie-signing key), `machines.json` (sharing), `config.json`, `usage.json`.

- **Automated:** `launchd/com.vmpanel.backup.plist` runs `launchers/backup.sh`
  **daily at 02:30**, writing a verified, retention-pruned tarball (keeps 14) to
  `VMP_BACKUP_DIR`. **Point `VMP_BACKUP_DIR` at an off-host volume** (mounted disk,
  synced folder, or rclone remote mount) for real disaster recovery — the default
  is on-host (`~/vm-panel-backups`), which does not survive host loss.
- **Restore:** `launchers/restore.sh [archive.tar.gz]` — stops the panel, keeps a
  `data.pre-restore_*` rollback copy, extracts the archive, and prints the start
  command. With no argument it restores the newest archive.
- **RPO/RTO:** with daily backups, worst-case data loss (RPO) ≈ 24 h — lower it by
  changing the timer cadence. Restore (RTO) is a few minutes: run `restore.sh`,
  then start the panel.
- Losing `secret` logs everyone out; losing `users.json` locks out admins
  (first-run recovery under Break-glass). Writes are atomic (temp + fsync + rename)
  and roll back in memory on a failed disk write, so a crash mid-write never
  corrupts these files.

## HTTPS (TLS front via Caddy) — required for microphone/camera

Browsers only grant microphone/camera (`getUserMedia`) in a **secure context**, so
the Media Desktop needs HTTPS. `install.sh` sets up a **Caddy** TLS front that
terminates HTTPS and proxies to the panel, preserving the two-origin isolation:

- `https://<host>:8443` → panel API  ·  `https://<host>:5443` → machine screens

One-time setup:

1. `brew install caddy` (if not present), then re-run `install.sh` (loads the
   `com.vmpanel.caddy` agent).
2. **Trust the internal CA** so the cert is valid: `sudo caddy trust` on this Mac.
   On other devices, import Caddy's root CA (`data/caddy/.../root.crt`) into the
   OS/browser trust store.
3. In `data/config.json` set `"publicTls": true` and `"publicHost": "<mDNS name>"`,
   then restart the panel. The panel then accepts its HTTPS origin in the
   host/Origin/CSP guards and serves screen URLs over `https://<host>:5443`.

Direct HTTP on `:5050` keeps working for localhost. Ports are >1024 so Caddy runs
as a normal launchd agent (no root).

## CI & provisioning

- `.github/workflows/ci.yml` runs the full `node --test` suite plus a shell lint on
  every push/PR — nothing untested reaches the host.
- `deploy/cloud-init.yaml` is an Infrastructure-as-Code starting point for a fresh
  Ubuntu/Graviton EC2 host (Docker + Node + systemd unit + backup timer). It also
  installs + loads `v4l2loopback` so Media Desktops get a working camera device.
- Third-party image licences: see `NOTICE.md`. Acceptable-use policy: `TERMS.md`.

## The Linux Desktop image

The **Modern** desktop is Ubuntu 24.04 with a dark-themed **XFCE** desktop
(Arc-Dark + Papirus icons), Firefox, a terminal, file manager, and text editor —
run headlessly via Xvfb + `dbus-launch` + x11vnc + noVNC (no systemd needed).
x11vnc is supervised (auto-restarts if it dies) and the image ships a
`HEALTHCHECK` on the noVNC bridge, so a wedged desktop shows as `unhealthy` in
`docker ps`.

The **Media** desktop (`images/media-desktop/`) is a thin layer over
`kasmweb/core-ubuntu-noble` (KasmVNC + PulseAudio) adding Firefox and audio/video
tools; its `HEALTHCHECK` probes the KasmVNC HTTPS port. Build both images with
`docker build -t minimal-media-desktop:xfce images/media-desktop`. The plain VNC
desktops are untouched.

- Build context: `images/linux-desktop/` (`Dockerfile`, `start.sh`, `xfconf/`).
- Rebuild (pin a dated tag alongside `:xfce`):
  `docker build -t minimal-linux-desktop:xfce -t minimal-linux-desktop:xfce-$(date +%Y%m%d) images/linux-desktop/`.
- The **Lightweight** desktop (`minimal-linux-desktop:icewm`) is the original,
  smaller IceWM build — kept as a template *and* as rollback. Templates pin
  `:xfce` / `:icewm` explicitly; `:latest` is no longer used.

## Files

- `server.js` — panel HTTP server + second machine-origin server, routing, auth
  wiring, proxy, stats/resources, docker/colima glue.
- `lib/` — `core.js` (pure logic: capabilities, templates, quota), `config.js`,
  `store.js` (atomic JSON), `auth.js` (scrypt/cookies/rate-limit), `users.js`,
  `sessions.js`, `shares.js` (sharing ACL), `stats.js` (usage parsers), `proxy.js`.
- `public/` — SPA: `index.html`, `style.css`, `app.js`, `js/*` ES modules
  (`views/{machines,admin,resources,auth}.js`, `stats-pop.js`, `charts.js`).
- `data/` — `users.json`, `sessions.json`, `machines.json` (sharing), `secret`,
  `config.json`, access log.
- `test/` — `node --test` suites (core, auth, users, sessions, shares, stats,
  proxy, and an integration harness with fake docker/colima shims).
- `images/linux-desktop/` — the XFCE image build context.
- `launchers/` — `start.sh` / `stop.sh` / `restart.sh` behind the Desktop
  `.command` one-click launchers.
