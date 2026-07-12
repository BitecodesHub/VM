// Pure logic for VM Panel — no side effects, no I/O. Unit-tested in test/core.test.js.

export const PANEL_PORT = 5050;
// Container ports are ALWAYS published on loopback — the panel's authenticated
// proxy is the only LAN-reachable path to a machine's UI.
export const LOOPBACK = '127.0.0.1';

// Ports the panel must never hand out to a new machine.
export const RESERVED_PORTS = new Set([5050, 6080, 7900, 4444, 9000, 9443]);

// Containers the panel refuses to delete.
export const PROTECTED_NAMES = new Set(['portainer']);

// Docker container-name grammar we accept from the API layer.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function validateName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

// Usernames: lowercase, label-safe (used in vmpanel.owner docker labels) and
// path-safe. 3-32 chars, must start with a letter.
export const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

export function validateUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

// ---- Ownership + quota -------------------------------------------------------

export const USER_RUNNING_LIMIT = 2;

// States that consume VM resources and therefore count toward a user's quota.
export const QUOTA_STATES = new Set(['running', 'restarting', 'paused']);

// The panel shows ONLY machines it created from its own templates. Every other
// container in the VM (Portainer, unrelated projects, adopted legacy desktops)
// is hidden from the UI entirely.
export const PANEL_TEMPLATES = new Set(['linux-desktop', 'icewm-desktop', 'chrome-node', 'firefox-node']);
export function isPanelMachine(card) {
  return !!card && card.managed === true && PANEL_TEMPLATES.has(card.template);
}

// ---- Capability model ------------------------------------------------------
// `sharedNames` is a Set of machine names shared with `user` (null/omitted for
// admins, who see everything). One choke point for every authorization check.
export function machineAccess(user, card, sharedNames = null) {
  if (!user || !card) return null;
  if (user.role === 'admin') return 'admin';
  if (card.owner === user.username) return 'owner';
  if (sharedNames && sharedNames.has(card.name)) return 'shared';
  return null;
}
export function canView(access) { return access !== null; }
export function canUse(access) { return access !== null; }            // open screen, start/stop/restart, logs, stats
export function canDelete(access) { return access === 'owner' || access === 'admin'; }
export function canManageAccess(access) { return access === 'admin'; } // sharing is admin-only (per product decision)

export function filterMachinesForUser(cards, user, sharedNames = null) {
  if (!user) return [];
  if (user.role === 'admin') return cards;
  return cards.filter((c) => c.owner === user.username || (sharedNames && sharedNames.has(c.name)));
}

// Backward-compatible boolean (= canUse). Kept so existing call sites/tests work;
// server.js migrates to the capability functions in the sharing wiring.
export function canUserActOnMachine(user, card, sharedNames = null) {
  return canUse(machineAccess(user, card, sharedNames));
}

export function quotaUsage(cards, username, limit = USER_RUNNING_LIMIT) {
  const used = cards.filter((c) => c.owner === username && QUOTA_STATES.has(c.state)).length;
  return { used, limit };
}

// Pure quota gate: would starting/creating one more machine for `owner` exceed
// the limit, given current cards and in-flight reservations?
export function quotaExceeded(cards, owner, pending = 0, limit = USER_RUNNING_LIMIT) {
  return quotaUsage(cards, owner, limit).used + pending >= limit;
}

// ---- Templates -------------------------------------------------------------

export const TEMPLATES = {
  // Both desktops are KasmVNC-based so speaker + microphone work by DEFAULT (VNC
  // desktops carry only pixels+input — they cannot do audio). Each serves its web
  // client + audio channels over ONE HTTPS port with Basic auth; the panel proxies
  // it under /m/<name>/ and satisfies the auth server-side, so the embedded screen
  // never prompts. XFCE is kasm's built-in DE; IceWM is launched via the image's
  // custom_startup.sh (START_XFCE4=0).
  //
  // Camera is OFF by default (needsWebcam:false + KASM_SVC_WEBCAM=0). Kasm's webcam
  // service crash-restart-loops against an idle v4l2loopback device with no frame
  // producer, burning ~1-1.5 vCPU PER desktop even when no camera is in use — the
  // dominant cause of desktop lag (A/B-measured ~86% -> ~5% container CPU when off).
  // Mic + speaker are unaffected (separate KASM_SVC_AUDIO services).
  'linux-desktop': {
    id: 'linux-desktop',
    label: 'Linux Desktop — XFCE',
    description: 'Full Ubuntu XFCE desktop — speaker and microphone work',
    hint: 'Recommended · mic + speaker',
    image: 'minimal-linux-desktop:xfce',
    namePrefix: 'desktop',
    uploadDir: '/home/kasm-user/Uploads',
    shmSize: '512m',
    memory: '2048m',
    cpus: 2,
    media: true,
    needsWebcam: false,
    env: [{ name: 'VNC_PW', value: 'secret' }, { name: 'KASM_SVC_WEBCAM', value: '0' }],
    backendTls: true,
    backendAuth: { user: 'kasm_user', pass: 'secret' },
    ports: [{ role: 'ui', containerPort: 6901, range: [6201, 6299] }],
    // password mode 'none': Kasm auth is entirely the injected Basic auth.
    ui: { path: '/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000', password: { mode: 'none' } },
  },
  'icewm-desktop': {
    id: 'icewm-desktop',
    label: 'Linux Desktop — IceWM (lightweight)',
    description: 'Snappier lightweight desktop — also with speaker and microphone',
    hint: 'Lightweight · mic + speaker',
    image: 'minimal-linux-desktop:icewm',
    namePrefix: 'desktop',
    uploadDir: '/home/kasm-user/Uploads',
    shmSize: '512m',
    memory: '1536m',
    cpus: 2,
    media: true,
    needsWebcam: false,
    env: [{ name: 'VNC_PW', value: 'secret' }, { name: 'KASM_SVC_WEBCAM', value: '0' }],
    backendTls: true,
    backendAuth: { user: 'kasm_user', pass: 'secret' },
    ports: [{ role: 'ui', containerPort: 6901, range: [6201, 6299] }],
    ui: { path: '/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000', password: { mode: 'none' } },
  },
  'chrome-node': {
    id: 'chrome-node',
    label: 'Chrome Node',
    description: 'Automated Chrome for testing (Selenium)',
    image: 'local-seleniarm/standalone-chromium:4.5.0-20260701',
    namePrefix: 'chrome-node',
    uploadDir: '/home/seluser/Downloads',
    shmSize: '2g',
    memory: '2048m',
    cpus: 2,
    ports: [
      { role: 'ui', containerPort: 7900, range: [7901, 7999] },
      { role: 'webdriver', containerPort: 4444, range: [4445, 4599] },
    ],
    // Same instant-connect flow as the desktops: the seleniarm image's x11vnc
    // runs -usepw with password "secret" and its noVNC honors ?password=.
    ui: { path: '/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000', password: { mode: 'query', value: 'secret' } },
    wdBrowserName: 'chrome', // W3C browserName the node's slots advertise (verified via GET /status)
  },
  'firefox-node': {
    id: 'firefox-node',
    label: 'Firefox Node',
    description: 'Automated Firefox for testing (Selenium)',
    image: 'local-seleniarm/standalone-firefox:4.5.0-20260701',
    namePrefix: 'firefox-node',
    uploadDir: '/home/seluser/Downloads',
    shmSize: '2g',
    memory: '2048m',
    cpus: 2,
    ports: [
      { role: 'ui', containerPort: 7900, range: [7901, 7999] },
      { role: 'webdriver', containerPort: 4444, range: [4445, 4599] },
    ],
    ui: { path: '/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000', password: { mode: 'query', value: 'secret' } },
    wdBrowserName: 'firefox',
  },
};

export function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({ id: t.id, label: t.label, image: t.image, description: t.description, hint: t.hint || null, media: !!t.media }));
}

// ---- Port allocation (pure part) ------------------------------------------

// First port in [lo, hi] that is not in `used` (a Set of numbers), or null.
// The impure bind-probe lives in the server; it feeds failures back via `used`.
export function firstFreePort([lo, hi], used) {
  for (let p = lo; p <= hi; p++) {
    if (!used.has(p) && !RESERVED_PORTS.has(p)) return p;
  }
  return null;
}

// ---- Name auto-increment ---------------------------------------------------

// Given a prefix and all existing container names, return `<prefix>-<n>` where
// n is one greater than the highest existing numeric suffix (min 1).
export function nextName(prefix, existingNames) {
  const re = new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`);
  let max = 0;
  for (const raw of existingNames) {
    const name = String(raw).replace(/^\//, '');
    const m = name.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${max + 1}`;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Port bindings from a docker inspect object ---------------------------

// Returns the host port bound to a given container port (number), or null.
export function hostPortFor(inspect, containerPort) {
  const key = `${containerPort}/tcp`;
  const pb = inspect?.HostConfig?.PortBindings?.[key];
  if (Array.isArray(pb) && pb[0]?.HostPort) return parseInt(pb[0].HostPort, 10);
  const ns = inspect?.NetworkSettings?.Ports?.[key];
  if (Array.isArray(ns) && ns[0]?.HostPort) return parseInt(ns[0].HostPort, 10);
  return null;
}

// Host binding (port + whether it is LAN-reachable) for a container port.
export function hostBindingFor(inspect, containerPort) {
  const key = `${containerPort}/tcp`;
  const pb = inspect?.HostConfig?.PortBindings?.[key];
  const entry = (Array.isArray(pb) && pb[0]) || (Array.isArray(inspect?.NetworkSettings?.Ports?.[key]) && inspect.NetworkSettings.Ports[key][0]) || null;
  if (!entry?.HostPort) return null;
  const ip = entry.HostIp ?? '';
  return { port: parseInt(entry.HostPort, 10), lan: ip === '' || ip === '0.0.0.0' || ip === '::' };
}

// All published host ports on a container, as [{host, container}] sorted by container port.
export function publishedPorts(inspect) {
  const out = [];
  const bindings = inspect?.HostConfig?.PortBindings || {};
  for (const [key, arr] of Object.entries(bindings)) {
    const containerPort = parseInt(key, 10);
    const host = Array.isArray(arr) && arr[0]?.HostPort ? parseInt(arr[0].HostPort, 10) : null;
    if (host != null) out.push({ host, container: containerPort });
  }
  return out.sort((a, b) => a.container - b.container);
}

// Collect every host port already bound across a list of inspect objects.
export function usedHostPorts(inspects) {
  const used = new Set();
  for (const insp of inspects) {
    for (const { host } of publishedPorts(insp)) used.add(host);
  }
  return used;
}

// ---- State mapping ---------------------------------------------------------

// docker State.Status -> panel state + human label.
export function mapState(status) {
  switch (status) {
    case 'running': return { state: 'running', statusText: 'Running' };
    case 'paused': return { state: 'paused', statusText: 'Paused' };
    case 'restarting': return { state: 'restarting', statusText: 'Restarting…' };
    case 'removing': return { state: 'removing', statusText: 'Removing…' };
    case 'dead': return { state: 'dead', statusText: 'Dead' };
    case 'created': return { state: 'stopped', statusText: 'Created' };
    case 'exited': return { state: 'stopped', statusText: 'Stopped' };
    default: return { state: 'unknown', statusText: status || 'Unknown' };
  }
}

// Which lifecycle actions are valid for a given panel state.
export function actionsFor(state) {
  switch (state) {
    case 'running': return ['stop', 'restart', 'logs'];
    case 'paused': return ['unpause', 'stop', 'logs'];
    case 'restarting': return ['stop', 'logs'];
    case 'stopped': return ['start', 'logs'];
    case 'dead': case 'removing': return ['logs'];
    default: return [];
  }
}

// ---- UI URL ----------------------------------------------------------------

// Panel-relative URL through the authenticated proxy. Injects noVNC's `path`
// query parameter so its WebSocket also rides through /m/<name>/websockify.
export function buildUiUrl(name, uiPath, password) {
  let url = `/m/${name}${uiPath}`;
  url += (uiPath.includes('?') ? '&' : '?') + 'path=' + encodeURIComponent(`m/${name}/websockify`);
  if (password?.mode === 'query' && password.value) {
    url += '&password=' + encodeURIComponent(password.value);
  }
  return url;
}

// ---- Container -> Card ------------------------------------------------------

// Adopt an unmanaged container by matching its image name.
function adoptByImage(image) {
  if (/(^|\/)minimal-linux-desktop\b/.test(image) || /^minimal-linux-desktop:/.test(image)) {
    const tpl = /:icewm\b/.test(image) ? 'icewm-desktop' : 'linux-desktop';
    return { template: tpl, ...TEMPLATES[tpl] };
  }
  if (/seleniarm\/standalone-chromium/.test(image)) {
    return { template: 'chrome-node', ...TEMPLATES['chrome-node'] };
  }
  if (/seleniarm\/standalone-firefox/.test(image)) {
    return { template: 'firefox-node', ...TEMPLATES['firefox-node'] };
  }
  if (/(^|\/)portainer\b/.test(image)) {
    return { template: 'portainer', special: 'portainer' };
  }
  return null;
}

// Convert a docker inspect object into a card for the UI.
export function mapContainerToCard(inspect) {
  const name = String(inspect?.Name || '').replace(/^\//, '');
  const image = inspect?.Config?.Image || '';
  const labels = inspect?.Config?.Labels || {};
  const status = inspect?.State?.Status || 'unknown';
  const { state, statusText } = mapState(status);
  const ports = publishedPorts(inspect);
  const protectedFlag = PROTECTED_NAMES.has(name);
  const startedAt = inspect?.State?.StartedAt && !/^0001-/.test(inspect.State.StartedAt) ? inspect.State.StartedAt : null;

  const managed = labels['vmpanel.managed'] === '1' || labels['vmpanel.managed'] === 'true';

  const exitCode = inspect?.State?.ExitCode ?? null;

  const card = {
    name, image, ports,
    state, statusText, startedAt, exitCode,
    managed,
    adopted: false,
    protected: protectedFlag,
    owner: labels['vmpanel.owner'] || null,
    template: labels['vmpanel.template'] || 'unknown',
    templateLabel: 'Unknown',
    uiPort: null,          // backend port for proxy resolution + readiness probe
    uiUrl: null,           // panel-relative for proxied machines; absolute loopback for localOnly
    localOnly: false,      // true => uiUrl only works on the Mac itself (not proxied)
    embeddable: false,
    passwordHint: null,
    webdriver: null,       // { port, lan } for Selenium nodes
    health: inspect?.State?.Health?.Status || null, // 'healthy'|'unhealthy'|'starting'|null
    capped: labels['vmpanel.capped'] === '1', // resources hard-capped vs shared
    media: false,          // KasmVNC media desktop (audio + mic + webcam)
    // Webcam wiring recorded at create time: '1' mapped, '0' host had none, null n/a.
    camera: labels['vmpanel.webcam'] === '1' ? true : (labels['vmpanel.webcam'] === '0' ? false : null),
  };

  if (managed) {
    const t = TEMPLATES[card.template];
    card.media = !!t?.media;
    const uiPort = labels['vmpanel.ui.port'] ? parseInt(labels['vmpanel.ui.port'], 10) : null;
    // The template definition is the source of truth for KNOWN templates so a UI
    // improvement (e.g. autoconnect) reaches existing containers whose immutable
    // ui.path label predates it. The label remains the fallback for containers
    // whose template no longer exists in the registry.
    const uiPath = t?.ui?.path || labels['vmpanel.ui.path'] || '/';
    card.templateLabel = t?.label || card.template;
    card.uiPort = uiPort;
    if (uiPort) {
      card.uiUrl = buildUiUrl(name, uiPath, t?.ui?.password);
      card.embeddable = true;
    }
    if (t?.ui?.password?.mode === 'prompt') card.passwordHint = t.ui.password.hint;
    const wdContainer = t?.ports?.find((p) => p.role === 'webdriver')?.containerPort;
    if (wdContainer) {
      const wd = hostBindingFor(inspect, wdContainer);
      if (wd) card.webdriver = wd;
    }
    return card;
  }

  // Unmanaged: adopt by image.
  const adopted = adoptByImage(image);
  if (adopted) {
    card.adopted = true;
    card.template = adopted.template;
    if (adopted.special === 'portainer') {
      card.templateLabel = 'Portainer';
      card.uiUrl = `http://${LOOPBACK}:9000`;
      card.uiPort = 9000;
      card.localOnly = true;
      card.embeddable = false;
      card.protected = true;
      return card;
    }
    card.templateLabel = adopted.label;
    card.media = !!adopted.media;
    const uiPort = hostPortFor(inspect, adopted.ports.find((p) => p.role === 'ui').containerPort);
    if (uiPort) {
      card.uiPort = uiPort;
      card.uiUrl = buildUiUrl(name, adopted.ui.path, adopted.ui.password);
      card.embeddable = true;
    }
    if (adopted.ui.password.mode === 'prompt') card.passwordHint = adopted.ui.password.hint;
    const wdSpec = adopted.ports.find((p) => p.role === 'webdriver');
    if (wdSpec) {
      const wd = hostBindingFor(inspect, wdSpec.containerPort);
      if (wd) card.webdriver = wd;
    }
    return card;
  }

  // Generic unknown container: local-only link if a port is published.
  card.templateLabel = 'Container';
  if (ports.length) {
    card.uiPort = ports[0].host;
    card.uiUrl = `http://${LOOPBACK}:${ports[0].host}`;
    card.localOnly = true;
  }
  return card;
}

// ---- docker run argument builder -------------------------------------------

// Build the execFile argument array for creating a machine.
// `ports` is a map of role -> allocated host port. `owner` is REQUIRED — every
// panel-created machine belongs to a user. The UI port is always loopback-bound
// (proxy-only access); the WebDriver port binds per `webdriverBind`.
export function buildRunArgs({ template, name, ports, createdAt, owner, webdriverBind = LOOPBACK, cap = false, hostWebcam = false }) {
  const t = TEMPLATES[template];
  if (!t) throw new Error(`unknown template: ${template}`);
  if (!validateUsername(owner)) throw new Error('buildRunArgs: valid owner is required');
  const ui = t.ports.find((p) => p.role === 'ui');
  const uiHost = ports.ui;

  const args = [
    'run', '-d',
    '--name', name,
    '--restart', 'unless-stopped',
    '--shm-size', t.shmSize,
    // Resources are SHARED (oversubscribed) by default so a machine can burst
    // into idle host capacity. With `cap`, apply the per-template hard limits:
    // memory (swap==memory ⇒ no swap) contains an OOM to the offender, and
    // --cpus bounds CPU. The choice is recorded in the vmpanel.capped label.
    ...(cap && t.memory ? ['--memory', t.memory, '--memory-swap', t.memory] : []),
    ...(cap && t.cpus ? ['--cpus', String(t.cpus)] : []),
    '-l', 'vmpanel.managed=1',
    '-l', `vmpanel.template=${template}`,
    '-l', `vmpanel.owner=${owner}`,
    '-l', `vmpanel.ui.port=${uiHost}`,
    '-l', `vmpanel.ui.path=${t.ui.path}`,
    '-l', `vmpanel.createdAt=${createdAt}`,
    '-l', `vmpanel.capped=${cap ? '1' : '0'}`,
    '-p', `${LOOPBACK}:${uiHost}:${ui.containerPort}`,
  ];

  // Template-declared environment (e.g. Kasm's VNC_PW = Basic-auth password).
  for (const e of t.env || []) args.push('-e', `${e.name}=${e.value}`);

  // Webcam passthrough: only when the template needs it AND the host actually
  // exposes a v4l2loopback device. On hosts without one (this Mac's Colima
  // kernel lacks v4l2loopback) the flag is omitted and the camera is reported
  // unavailable — audio/mic still work. The label records the wiring either way.
  if (t.needsWebcam) {
    args.push('-l', `vmpanel.webcam=${hostWebcam ? '1' : '0'}`);
    if (hostWebcam) args.push('--device', '/dev/video0:/dev/video0');
  }

  const wd = t.ports.find((p) => p.role === 'webdriver');
  if (wd && ports.webdriver) {
    args.push('-l', `vmpanel.webdriver.port=${ports.webdriver}`);
    args.push('-p', `${webdriverBind}:${ports.webdriver}:${wd.containerPort}`);
  }

  args.push(t.image);
  return args;
}

// ---- LAN address discovery ---------------------------------------------------

const RFC1918 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

// Pure: pass os.networkInterfaces() output. Prefers en0, then lowest en* with a
// private IPv4, then any external IPv4. Returns a string address or null.
export function pickLanAddress(interfaces) {
  const candidates = [];
  for (const [ifname, addrs] of Object.entries(interfaces || {})) {
    if (/^(utun|awdl|llw|bridge|vmnet|lo)/.test(ifname)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      candidates.push({ ifname, address: a.address, rfc1918: RFC1918.test(a.address) });
    }
  }
  if (!candidates.length) return null;
  const en0 = candidates.find((c) => c.ifname === 'en0');
  if (en0) return en0.address;
  const en = candidates
    .filter((c) => /^en\d+$/.test(c.ifname) && c.rfc1918)
    .sort((a, b) => a.ifname.localeCompare(b.ifname, undefined, { numeric: true }));
  if (en.length) return en[0].address;
  return candidates[0].address;
}

// ---- colima list --json parsing --------------------------------------------

export function parseColimaList(stdout, profile = 'default') {
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  let picked = null;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.name === profile) { picked = obj; break; }
    if (!picked) picked = obj;
  }
  if (!picked) return { running: false, status: 'Unknown', cpu: null, memoryGiB: null, diskGiB: null, memoryBytes: null, diskBytes: null, arch: null };
  return {
    running: /running/i.test(picked.status || ''),
    status: picked.status || 'Unknown',
    cpu: picked.cpus ?? null,
    memoryGiB: picked.memory ? Math.round(picked.memory / 1024 ** 3) : null,
    diskGiB: picked.disk ? Math.round(picked.disk / 1024 ** 3) : null,
    memoryBytes: picked.memory ?? null,
    diskBytes: picked.disk ?? null,
    arch: picked.arch || null,
  };
}
