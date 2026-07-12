// Machines view: create tiles, machine cards, embedded viewer, logs.
import { api, friendlyError } from '../api.js';
import { store } from '../store.js';
import { $, el, esc, ICONS, toast, copyText, confirmModal, openDialog, closeDialog } from '../ui.js';
import { openStatsPop } from '../stats-pop.js';
import { filterSortMachines, SORT_OPTIONS } from '../machine-filter.js';

// A machine that never answers its readiness probe would otherwise sit on
// "Booting…" forever. Track when each first appeared running-but-not-ready; past
// this budget we surface an escape hatch ("Open anyway") + a check-logs hint.
const BOOT_TIMEOUT_MS = 90_000;
const bootSince = new Map(); // name -> first ts seen running & not ready
function bootElapsed(name, running, ready) {
  if (!running || ready) { bootSince.delete(name); return 0; }
  if (!bootSince.has(name)) bootSince.set(name, Date.now());
  return Date.now() - bootSince.get(name);
}

// Fallback tile list until /api/templates loads (store.templates is authoritative).
const FALLBACK_TEMPLATES = [
  { id: 'linux-desktop', label: 'Linux Desktop — XFCE', description: 'Full XFCE desktop — mic & speaker work', hint: 'Recommended · mic + speaker', media: true },
  { id: 'icewm-desktop', label: 'Linux Desktop — IceWM (lightweight)', description: 'Snappier lightweight desktop — mic & speaker work', hint: 'Lightweight · mic + speaker', media: true },
  { id: 'chrome-node', label: 'Chrome Node', description: 'Automated Chrome (Selenium)' },
  { id: 'firefox-node', label: 'Firefox Node', description: 'Automated Firefox (Selenium)' },
];
function templates() { return store.templates && store.templates.length ? store.templates : FALLBACK_TEMPLATES; }

function iconFor(t) { return (t === 'linux-desktop' || t === 'icewm-desktop') ? ICONS.desktop : (t === 'chrome-node' || t === 'firefox-node') ? ICONS.browser : ICONS.container; }

// Two-step create: pick a category, then a specific template inside it.
const CATEGORIES = [
  { id: 'desktop', label: 'Linux Desktop', desc: 'A full graphical Linux desktop (with mic + speaker) in your browser', templateIds: ['linux-desktop', 'icewm-desktop'], hintCls: 'rec' },
  { id: 'browser', label: 'Browser Node', desc: 'Automated Chrome / Firefox for testing (Selenium)', templateIds: ['chrome-node', 'firefox-node'], hintCls: 'lite' },
];
function templatesInCategory(catId) {
  const cat = CATEGORIES.find((c) => c.id === catId);
  if (!cat) return [];
  const byId = new Map(templates().map((t) => [t.id, t]));
  return cat.templateIds.map((id) => byId.get(id)).filter(Boolean);
}
function categoriesWithTemplates() {
  return CATEGORIES
    .map((c) => ({ ...c, icon: c.id === 'desktop' ? ICONS.desktop : ICONS.browser, count: templatesInCategory(c.id).length }))
    .filter((c) => c.count > 0);
}

// P0-2: machine screens live on a second origin (panel.machinePort). Build the
// absolute URL to that origin; localOnly machines keep their loopback URL.
function machineUrl(m) {
  if (!m.uiUrl) return null;
  if (m.localOnly) return m.uiUrl;
  const panel = store.state?.panel || {};
  // Behind the Caddy TLS front (page loaded over HTTPS), screens live on the
  // machine HTTPS port so mic/camera get a secure context; otherwise the plain
  // second origin (machinePort).
  if (location.protocol === 'https:' && panel.machineHttpsPort) {
    return `https://${location.hostname}:${panel.machineHttpsPort}${m.uiUrl}`;
  }
  if (!panel.machinePort) return m.uiUrl;
  return `${location.protocol}//${location.hostname}:${panel.machinePort}${m.uiUrl}`;
}

function uptime(startedAt) {
  if (!startedAt) return '';
  const then = Date.parse(startedAt); if (!then) return '';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `up ${s}s`;
  if (s < 3600) return `up ${Math.floor(s / 60)}m`;
  if (s < 86400) return `up ${Math.floor(s / 3600)}h`;
  return `up ${Math.floor(s / 86400)}d`;
}

// Render the machines area. opts: { showCreate, showOwner, title, ownerScope }
// ownerScope (a username) client-filters to that owner — used for an admin's
// "My machines" tab, since the server returns all machines to admins.
export function renderMachines(root, { showCreate = true, showOwner = false, title = 'Your machines', ownerScope = null } = {}) {
  const st = store.state;
  if (!st) return;
  const quota = st.quota;
  const atLimit = quota && quota.used >= quota.limit;
  root.innerHTML = '';

  if (showCreate) {
    const sec = el('<section class="create-section"></section>');
    sec.appendChild(el('<h2 class="section-title">Create a machine</h2>'));
    const tiles = el('<div class="tiles"></div>');
    const busyCreate = store.pendingCreate.size > 0;
    for (const cat of categoriesWithTemplates()) {
      const disabled = !st.vm?.running || !!st.vm?.transition || atLimit || busyCreate;
      const tile = el(`<button class="tile" data-category="${esc(cat.id)}" ${disabled ? 'aria-disabled="true"' : ''} aria-label="Create ${esc(cat.label)}">
        <span class="tile-icon">${cat.icon}</span>
        <span class="tile-name">${esc(cat.label)}</span>
        <span class="tile-desc">${esc(cat.desc)}</span>
        <span class="tile-hint ${cat.hintCls}">${esc(cat.count)} option${cat.count === 1 ? '' : 's'}</span>
        ${atLimit ? '<span class="tile-quota-note">Machine limit reached</span>' : ''}
      </button>`);
      tiles.appendChild(tile);
    }
    sec.appendChild(tiles);
    root.appendChild(sec);
  }

  const machines = ownerScope ? (st.machines || []).filter((m) => m.owner === ownerScope) : (st.machines || []);
  const sec = el('<section class="machines-section"></section>');
  sec.appendChild(el(`<h2 class="section-title">${esc(title)} <span class="count">${machines.length ? `(${machines.length})` : ''}</span></h2>`));

  // Controls bar: owner filter (admin only) + free-text search + sort. Shown
  // once there is anything to filter.
  let scoped = machines;
  if (machines.length) {
    const bar = el('<div class="filter-bar"></div>');
    if (showOwner) {
      const owners = [...new Set(machines.map((m) => m.owner || '—'))].sort();
      const sel = el('<select class="select" id="owner-filter" aria-label="Filter by owner"><option value="">All owners</option></select>');
      for (const o of owners) sel.appendChild(el(`<option value="${esc(o)}" ${store.ownerFilter === o ? 'selected' : ''}>${esc(o)}</option>`));
      sel.addEventListener('change', () => { store.ownerFilter = sel.value; renderMachines(root, { showCreate, showOwner, title, ownerScope }); });
      bar.appendChild(sel);
      if (store.ownerFilter) scoped = machines.filter((m) => (m.owner || '—') === store.ownerFilter);
    }
    const search = el(`<input class="text-input list-search" id="machine-search" type="search" placeholder="Search machines…" aria-label="Search machines" value="${esc(store.machineSearch || '')}" />`);
    search.addEventListener('input', () => { store.machineSearch = search.value; store.searchFocused = true; renderMachines(root, { showCreate, showOwner, title, ownerScope }); });
    search.addEventListener('focus', () => { store.searchFocused = true; });
    search.addEventListener('blur', () => { store.searchFocused = false; });
    bar.appendChild(search);
    const sort = el(`<select class="select" id="machine-sort" aria-label="Sort machines">${SORT_OPTIONS.map((o) => `<option value="${esc(o.value)}" ${store.machineSort === o.value ? 'selected' : ''}>Sort: ${esc(o.label)}</option>`).join('')}</select>`);
    sort.addEventListener('change', () => { store.machineSort = sort.value; renderMachines(root, { showCreate, showOwner, title, ownerScope }); });
    bar.appendChild(sort);
    sec.appendChild(bar);
  }

  const filtered = filterSortMachines(scoped, { q: store.machineSearch, sort: store.machineSort });

  const grid = el('<div class="grid"></div>');
  for (const m of filtered) grid.appendChild(renderCard(m, showOwner));
  sec.appendChild(grid);
  if (!filtered.length) {
    const msg = machines.length === 0
      ? (showCreate ? 'No machines yet. Create one above to get started.' : 'No machines here yet.')
      : 'No machines match your search.';
    sec.appendChild(el(`<p class="empty">${msg}</p>`));
  }
  root.appendChild(sec);
  // Preserve the search box's focus + caret across the 4s poll re-render.
  if (store.searchFocused) {
    const s = root.querySelector('#machine-search');
    if (s) { s.focus(); const v = s.value; try { s.setSelectionRange(v.length, v.length); } catch { /* ignore */ } }
  }

  for (const m of filtered) {
    if (m.state === 'running' && m.embeddable && m.uiPort && !store.ready.get(m.name)) probeReady(m.name);
    if (m.state !== 'running') store.ready.delete(m.name);
  }
}

function renderCard(m, showOwner) {
  const card = el(`<div class="card${store.state.stale ? ' stale' : ''}" data-name="${esc(m.name)}"></div>`);
  const head = el('<div class="card-head"></div>');
  head.appendChild(el(`<span class="card-ico">${iconFor(m.template)}</span>`));
  const meta = el('<div class="card-headmeta"></div>');
  meta.appendChild(el(`<span class="card-name">${esc(m.name)}</span>`));
  meta.appendChild(el(`<span class="card-type">${esc(m.templateLabel)}</span>`));
  head.appendChild(meta);
  const badges = el('<div class="badges"></div>');
  if (m.access === 'shared') badges.appendChild(el(`<span class="badge shared-badge" title="Shared with you by ${esc(m.owner || '')}">shared by ${esc(m.owner || '')}</span>`));
  if (showOwner && m.owner) badges.appendChild(el(`<span class="badge owner-badge" title="Owner">${esc(m.owner)}</span>`));
  if (showOwner && m.sharedWith && m.sharedWith.length) badges.appendChild(el(`<span class="badge" title="Shared with ${esc(m.sharedWith.join(', '))}">shared ×${m.sharedWith.length}</span>`));
  if (m.protected) badges.appendChild(el('<span class="badge shield" title="Protected — cannot be deleted">protected</span>'));
  if (m.localOnly) badges.appendChild(el('<span class="badge" title="Only reachable on the host Mac">local only</span>'));
  if (m.capped) badges.appendChild(el('<span class="badge" title="CPU & memory hard-capped for this machine">capped</span>'));
  if (m.media) {
    // Speaker + mic always work. Camera is off by default (the webcam service is
    // a heavy CPU spinner), so only show the camera capability when one was
    // explicitly mapped in at create time.
    const cam = m.camera === true ? 'mic · speaker · camera' : 'mic · speaker';
    const camTitle = m.camera === true
      ? 'Speaker, microphone and webcam work in this desktop'
      : 'Speaker and microphone work in this desktop';
    badges.appendChild(el(`<span class="badge media-badge" title="${esc(camTitle)}">${esc(cam)}</span>`));
  }
  // ⓘ resource usage — for running machines the user can see.
  const info = el(`<button class="icon-btn info-btn" data-act="info" title="Resource usage" aria-label="Resource usage for ${esc(m.name)}">i</button>`);
  badges.appendChild(info);
  head.appendChild(badges);
  card.appendChild(head);

  const up = m.state === 'running' ? uptime(m.startedAt) : '';
  card.appendChild(el(`<div class="card-status"><span class="dot ${m.state}"></span>${esc(m.statusText)}${up ? ` · ${esc(up)}` : ''}</div>`));
  if (m.state === 'running' && !store.ready.get(m.name) && !store.busy.has(m.name) && bootElapsed(m.name, true, false) > BOOT_TIMEOUT_MS) {
    card.appendChild(el('<div class="card-hint warn">Taking longer than usual to respond — try “Open anyway”, or check Logs.</div>'));
  }

  const busy = store.busy.has(m.name) || store.state.stale;
  const running = m.state === 'running';
  const ready = store.ready.get(m.name);

  if (m.uiUrl) {
    const access = el('<div class="access"></div>');
    const row = el('<div class="access-row"></div>');
    const stuck = running && !ready && !busy && bootElapsed(m.name, running, ready) > BOOT_TIMEOUT_MS;
    // After the boot budget, let the user open anyway (the viewer shows the real
    // connection state) instead of being stuck on a disabled "Booting…".
    const canOpen = (running && ready && !busy) || stuck;
    const label = (base) => (running && !ready ? (stuck ? 'Open anyway' : 'Booting…') : base);
    if (m.webdriver && m.embeddable) {
      // Selenium node: "Open browser" starts a real browser window on the node's
      // screen and opens the viewer. Once live, viewing is the primary action.
      if (m.browserActive) {
        row.appendChild(el(`<button class="btn primary" data-act="open" ${canOpen ? '' : 'disabled'}>Open UI</button>`));
        row.appendChild(el(`<button class="btn" data-act="browser-close" ${busy ? 'disabled' : ''}>Close browser</button>`));
      } else {
        row.appendChild(el(`<button class="btn primary" data-act="browser" ${canOpen ? '' : 'disabled'}>${label('Open browser')}</button>`));
        row.appendChild(el(`<button class="btn" data-act="open" ${canOpen ? '' : 'disabled'}>Open UI</button>`));
      }
    } else if (m.embeddable) {
      row.appendChild(el(`<button class="btn primary" data-act="open" ${canOpen ? '' : 'disabled'}>${label('Open UI')}</button>`));
    }
    const abs = machineUrl(m);
    // Under the HTTPS front, a fresh tab hits the machine origin directly — if the
    // internal CA isn't trusted the browser shows a cert warning; hint at it.
    const newTabTitle = store.state?.panel?.tls ? 'Opens the screen on its own HTTPS origin (accept the certificate once if prompted)' : 'Open the screen in a new browser tab';
    row.appendChild(el(`<a class="btn" href="${esc(abs)}" target="_blank" rel="noopener" title="${esc(newTabTitle)}">Open in new tab ↗</a>`));
    row.appendChild(el(`<button class="copy-btn" data-copy="${esc(abs)}" title="Copy link" aria-label="Copy link"><span class="ico">${ICONS.copy}</span></button>`));
    if (m.webdriver) {
      const host = m.webdriver.lan ? location.hostname : '127.0.0.1';
      row.appendChild(el(`<a class="btn small" href="http://${host}:${m.webdriver.port}/ui" target="_blank" rel="noopener" title="${m.webdriver.lan ? 'Selenium Grid' : 'Grid (local only)'}">Grid ↗</a>`));
    }
    access.appendChild(row);
    if (m.webdriver) {
      // Copyable WebDriver endpoint for running tests against this node.
      const host = m.webdriver.lan ? location.hostname : '127.0.0.1';
      const wdUrl = `http://${host}:${m.webdriver.port}`;
      const wd = el('<div class="access-row"></div>');
      wd.appendChild(el(`<span class="pw-chip">WebDriver: ${esc(wdUrl)}<button class="copy-btn" data-copy="${esc(wdUrl)}" title="Copy WebDriver URL" aria-label="Copy WebDriver URL"><span class="ico">${ICONS.copy}</span></button></span>`));
      if (!m.webdriver.lan) wd.appendChild(el('<span class="link-chip">this Mac only</span>'));
      access.appendChild(wd);
    }
    if (m.passwordHint) {
      const pw = el('<div class="access-row"></div>');
      pw.appendChild(el(`<span class="pw-chip">VNC password: ${esc(m.passwordHint)}<button class="copy-btn" data-copy="${esc(m.passwordHint)}" title="Copy password" aria-label="Copy password"><span class="ico">${ICONS.copy}</span></button></span>`));
      access.appendChild(pw);
    }
    card.appendChild(access);
  }

  const actions = el('<div class="card-actions"></div>');
  if (!store.state.stale) {
    const dis = busy ? 'disabled' : '';
    if (running) {
      actions.appendChild(el(`<button class="btn small" data-act="stop" ${dis}>Stop</button>`));
      actions.appendChild(el(`<button class="btn small" data-act="restart" ${dis}>Restart</button>`));
    } else if (m.state === 'stopped') {
      actions.appendChild(el(`<button class="btn small" data-act="start" ${dis}>Start</button>`));
    } else if (m.state === 'paused') {
      actions.appendChild(el(`<button class="btn small" data-act="unpause" ${dis}>Resume</button>`));
    }
    actions.appendChild(el(`<button class="btn small" data-act="logs" ${dis}>Logs</button>`));
    if (running) actions.appendChild(el(`<button class="btn small" data-act="files" ${dis}>Files</button>`));
    // Admins manage sharing from the All-machines tab.
    if (showOwner && store.user?.role === 'admin') actions.appendChild(el(`<button class="btn small" data-act="access" ${dis}>Manage access</button>`));
    // Shared users can use but not delete; owner/admin can.
    if (!m.protected && m.access !== 'shared') actions.appendChild(el(`<button class="btn small danger" data-act="delete" ${dis}>Delete</button>`));
  }
  if (actions.children.length) card.appendChild(actions);
  return card;
}

async function probeReady(name) {
  const res = await api.get(`/api/machines/${encodeURIComponent(name)}/ready`);
  if (res.handled) return;
  if (res.data?.ready) { store.ready.set(name, true); store.rerender?.(); }
}

function machineByName(name) { return (store.state?.machines || []).find((m) => m.name === name); }

// ---- Actions ---------------------------------------------------------------
export async function doCreate(template, opts = {}) {
  store.pendingCreate.add(template); store.rerender?.();
  try {
    const res = await api.post('/api/machines', { template, ...opts });
    if (res.handled) return false;
    if (res.ok) {
      const shared = (res.data.sharedWith || []).length;
      toast('ok', `Created ${res.data.name}`, shared ? `Shared with ${shared} ${shared === 1 ? 'person' : 'people'}. Starting up…` : 'Starting up — “Open UI” lights up in a few seconds.');
      store.requestPoll?.();
      return true;
    }
    toast('err', friendlyError(res.data, 'Could not create the machine'));
    return false;
  } finally { store.pendingCreate.delete(template); store.rerender?.(); }
}

// Admin create dialog: name it + assign viewers (who can use, not delete).
// Two-step create wizard: category (already chosen) → template + options.
async function openCreateWizard(catId) {
  const cat = CATEGORIES.find((c) => c.id === catId);
  const tpls = templatesInCategory(catId);
  if (!cat || !tpls.length) return;
  const isAdmin = store.user?.role === 'admin';
  let candidates = [];
  if (isAdmin) { const ur = await api.get('/api/users'); if (ur.handled) return; candidates = ur.ok ? ur.data.users.filter((u) => u.username !== store.user.username && !u.disabled && u.role !== 'admin') : []; }

  const picks = tpls.map((t, i) => `<label class="pick-card"><input type="radio" name="tpl" value="${esc(t.id)}" ${i === 0 ? 'checked' : ''}/><span class="pick-body"><span class="pick-name">${esc(t.label)}</span><span class="pick-desc">${esc(t.description || '')}</span></span>${t.hint ? `<span class="tile-hint ${t.hint === 'Recommended' ? 'rec' : 'lite'}">${esc(t.hint)}</span>` : ''}</label>`).join('');
  const adminFields = isAdmin ? `
      <label class="field-label" for="cr-name">Name <span class="stat-note">(optional — blank auto-names)</span></label>
      <input class="input" id="cr-name" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. reception-desktop" maxlength="64"/>
      <p class="field-label" style="margin-top:12px">Who can view &amp; use it <span class="stat-note">(cannot delete)</span></p>
      <div class="access-list">${candidates.map((u) => `<label class="check-row"><input type="checkbox" value="${esc(u.username)}"/> <span>${esc(u.username)}</span></label>`).join('') || '<p class="stat-note">No other users yet.</p>'}</div>
      <label class="check-row" style="margin-top:12px"><input type="checkbox" id="cr-cap"/> <span>Cap CPU &amp; memory for this machine <span class="stat-note">(default: shared with other machines)</span></span></label>` : '';

  const modal = el('<div class="overlay" data-overlay></div>');
  const panel = el(`<div class="modal small" role="dialog" aria-modal="true" aria-label="Create ${esc(cat.label)}">
    <div class="overlay-head"><span class="overlay-title">New ${esc(cat.label)}</span><span class="spacer"></span><button class="btn ghost" data-x>Close ✕</button></div>
    <div class="confirm-body">
      <p class="field-label">Choose a type</p>
      <div class="pick-list">${picks}</div>
      <p class="stat-note hidden" id="cr-media-tip"></p>
      ${adminFields}
      <div class="form-error" id="cr-err"></div>
    </div>
    <div class="confirm-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-create>Create</button></div>
  </div>`);
  modal.appendChild(panel);
  document.body.appendChild(modal);
  const close = () => { closeDialog(modal); modal.remove(); };
  panel.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
  openDialog(modal, { initialFocus: 'input[name=tpl]' });
  const err = panel.querySelector('#cr-err');

  // Media Desktop tip: the viewer's browser will ask permission for mic/camera,
  // and that only works over HTTPS (a "secure context"). Warn when the panel is
  // being used over plain HTTP so the admin knows to open it via the TLS front.
  const mediaIds = new Set(tpls.filter((t) => t.media).map((t) => t.id));
  const mediaTip = panel.querySelector('#cr-media-tip');
  const secure = window.isSecureContext || store.state?.panel?.secureContext;
  const syncMediaTip = () => {
    const sel = panel.querySelector('input[name=tpl]:checked')?.value;
    if (sel && mediaIds.has(sel)) {
      mediaTip.innerHTML = secure
        ? '🎙️ When you open this desktop, your browser will ask to use the microphone — allow it. Speaker plays automatically. (Camera is off by default.)'
        : '⚠️ Speaker and mic need HTTPS. Open the panel via its secure address (the TLS front) or the browser will block the microphone.';
      mediaTip.classList.toggle('warn', !secure);
      mediaTip.classList.remove('hidden');
    } else {
      mediaTip.classList.add('hidden');
    }
  };
  panel.querySelectorAll('input[name=tpl]').forEach((r) => r.addEventListener('change', syncMediaTip));
  syncMediaTip();

  panel.querySelector('[data-create]').addEventListener('click', async () => {
    const template = panel.querySelector('input[name=tpl]:checked')?.value;
    if (!template) { err.textContent = 'Pick a type.'; return; }
    const nameEl = panel.querySelector('#cr-name');
    const name = nameEl ? nameEl.value.trim() : '';
    if (name && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) { err.textContent = 'Name: letters, digits, _ . - only (must start alphanumeric).'; return; }
    const viewers = [...panel.querySelectorAll('.access-list input[type=checkbox]:checked')].map((c) => c.value);
    const cap = isAdmin ? !!panel.querySelector('#cr-cap')?.checked : undefined;
    const btn = panel.querySelector('[data-create]'); btn.disabled = true; btn.textContent = 'Creating…';
    const ok = await doCreate(template, { name: name || undefined, viewers, cap });
    if (ok) close();
    else { btn.disabled = false; btn.textContent = 'Create'; err.textContent = err.textContent || 'Could not create — see the message above.'; }
  });
}

async function doLifecycle(name, act) {
  store.busy.add(name); store.rerender?.();
  try {
    const res = await api.post(`/api/machines/${encodeURIComponent(name)}/${act}`);
    if (res.handled) return;
    const verb = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', unpause: 'Resuming' }[act] || act;
    // User-facing verb for failures — never leak the raw docker action name (e.g. "unpause").
    const failVerb = { start: 'start', stop: 'stop', restart: 'restart', unpause: 'resume' }[act] || act;
    if (res.ok) { toast('ok', `${verb} ${name}`); store.requestPoll?.(); }
    else { toast('err', friendlyError(res.data, `Could not ${failVerb} ${name}`)); if (res.status === 404) store.requestPoll?.(); }
  } finally { store.busy.delete(name); store.rerender?.(); }
}

// Start a live browser window on a Selenium node, then open the screen.
async function doBrowser(name) {
  store.busy.add(name); store.rerender?.();
  try {
    const res = await api.post(`/api/machines/${encodeURIComponent(name)}/browser`);
    if (res.handled) return;
    if (res.ok) {
      toast('ok', `Browser opened on ${name}`);
      store.requestPoll?.();
      const m = machineByName(name);
      if (m) openViewer(m);
    } else {
      toast('err', friendlyError(res.data, 'Could not open a browser on this node'));
    }
  } finally { store.busy.delete(name); store.rerender?.(); }
}

async function doBrowserClose(name) {
  store.busy.add(name); store.rerender?.();
  try {
    const res = await api.del(`/api/machines/${encodeURIComponent(name)}/browser`);
    if (res.handled) return;
    if (res.ok) { toast('ok', `Browser closed on ${name}`); store.requestPoll?.(); }
    else toast('err', friendlyError(res.data, 'Could not close the browser'));
  } finally { store.busy.delete(name); store.rerender?.(); }
}

async function doDelete(name) {
  const m = machineByName(name);
  const typed = m && !m.managed && !m.adopted ? name : (m && m.adopted ? name : null);
  const conf = await confirmModal({
    title: `Delete ${name}?`,
    msg: typed ? 'This machine was not created by you here. Type its name to confirm removal.' : `This will stop and permanently remove “${name}”. This cannot be undone.`,
    typed,
  });
  if (!conf.ok) return;
  store.busy.add(name); store.rerender?.();
  try {
    const res = await api.del(`/api/machines/${encodeURIComponent(name)}`, { confirm: name });
    if (res.handled) return;
    if (res.ok) { toast('ok', `Deleted ${name}`); store.requestPoll?.(); }
    else toast('err', friendlyError(res.data, 'Delete failed'));
  } finally { store.busy.delete(name); store.rerender?.(); }
}

// ---- Viewer ----------------------------------------------------------------
function openViewer(m) {
  $('#viewer-title').textContent = m.name;
  const hint = $('#viewer-hint'); const tip = $('#viewer-tip');
  if (m.passwordHint) {
    hint.textContent = `VNC password: ${m.passwordHint}`; hint.classList.remove('hidden');
    tip.innerHTML = `Click <b>Connect</b>, then enter the password <b>${esc(m.passwordHint)}</b> (copied to your clipboard).`;
    tip.classList.remove('hidden');
    navigator.clipboard?.writeText(m.passwordHint).catch(() => {});
  } else if (m.webdriver && !m.browserActive) {
    // Selenium node with no live browser: explain the empty desktop.
    const host = m.webdriver.lan ? location.hostname : '127.0.0.1';
    hint.classList.add('hidden');
    tip.innerHTML = `This is a test-browser node — the screen is empty until a browser runs. Use <b>Open browser</b> on the card, or point WebDriver tests at <b>http://${esc(host)}:${m.webdriver.port}</b>.`;
    tip.classList.remove('hidden');
  } else { hint.classList.add('hidden'); tip.classList.add('hidden'); }
  const url = machineUrl(m);
  const sel = $('#viewer-resize');
  const applyResize = (mode) => { const u = url.replace(/resize=(scale|off|remote)/, `resize=${mode}`); $('#viewer-newtab').href = u; $('#viewer-frame').src = u; };
  if (sel) {
    const cur = (url.match(/resize=(scale|off|remote)/) || [])[1] || 'scale';
    sel.value = cur;
    sel.onchange = () => applyResize(sel.value);
  }
  applyResize(sel ? sel.value : 'scale');
  openDialog($('#viewer'), { initialFocus: '#viewer-close' });
}
export function closeViewer() { closeDialog($('#viewer')); $('#viewer-frame').src = 'about:blank'; }

// ---- Logs ------------------------------------------------------------------
let logsName = null;
function openLogs(name) { logsName = name; $('#logs-title').textContent = `Logs — ${name}`; openDialog($('#logs'), { initialFocus: '#logs-close' }); refreshLogs(); }
export async function refreshLogs() {
  if (!logsName) return;
  $('#logs-body').textContent = 'Loading…';
  const res = await fetch(`/api/machines/${encodeURIComponent(logsName)}/logs?tail=${$('#logs-tail').value}`, { cache: 'no-store' });
  if (res.status === 401) { closeLogs(); return; }
  $('#logs-body').textContent = (await res.text()) || '(no output yet)';
  $('#logs-body').scrollTop = $('#logs-body').scrollHeight;
}
export function closeLogs() { closeDialog($('#logs')); logsName = null; }

// ---- Event delegation (bound once by app.js on #view-root) -----------------
export function handleMachineClick(e) {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) { copyText(copyBtn.dataset.copy); return; }
  const tile = e.target.closest('.tile[data-category]');
  if (tile) {
    if (tile.getAttribute('aria-disabled') === 'true') { toast('info', store.state?.quota && store.state.quota.used >= store.state.quota.limit ? 'Machine limit reached. Stop or delete one first.' : 'Unavailable right now.'); return; }
    openCreateWizard(tile.dataset.category);
    return;
  }
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const name = e.target.closest('.card')?.dataset.name;
  if (!name) return;
  const act = btn.dataset.act;
  const m = machineByName(name);
  if (act === 'open') openViewer(m);
  else if (act === 'browser') doBrowser(name);
  else if (act === 'browser-close') doBrowserClose(name);
  else if (act === 'logs') openLogs(name);
  else if (act === 'files') openFilesModal(name);
  else if (act === 'delete') doDelete(name);
  else if (act === 'info') openStatsPop(name, btn);
  else if (act === 'access') openAccessModal(name);
  else doLifecycle(name, act);
}

// ---- Files modal (upload / download / delete via docker cp) ----------------
function fmtSize(n) { if (!Number.isFinite(n)) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n; while (v >= 1024 && i < 3) { v /= 1024; i++; } return `${v.toFixed(i ? 1 : 0)} ${u[i]}`; }

async function openFilesModal(name) {
  const modal = el('<div class="overlay" data-overlay></div>');
  const panel = el(`<div class="modal small" role="dialog" aria-modal="true">
    <div class="overlay-head"><span class="overlay-title">Files — ${esc(name)}</span><span class="spacer"></span><button class="btn ghost" data-x>Close ✕</button></div>
    <div class="confirm-body">
      <div class="access-row"><label class="btn primary" style="cursor:pointer">Upload file<input type="file" id="file-input" hidden></label><span class="stat-note" id="file-dir"></span></div>
      <div class="form-error" id="file-err"></div>
      <div class="access-list" id="file-list"><p class="stat-note">Loading…</p></div>
    </div>
    <div class="confirm-actions"><button class="btn ghost" data-x>Done</button></div>
  </div>`);
  modal.appendChild(panel);
  document.body.appendChild(modal);
  const close = () => { closeDialog(modal); modal.remove(); };
  panel.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
  openDialog(modal, { initialFocus: '[data-x]' });
  const err = panel.querySelector('#file-err');

  async function refresh() {
    const res = await api.get(`/api/machines/${encodeURIComponent(name)}/files`);
    if (res.handled) { close(); return; }
    const list = panel.querySelector('#file-list');
    if (!res.ok) { list.innerHTML = `<p class="stat-note">${esc(friendlyError(res.data, 'Could not list files'))}</p>`; return; }
    panel.querySelector('#file-dir').textContent = res.data.dir || '';
    const files = res.data.files || [];
    if (!files.length) { list.innerHTML = '<p class="stat-note">No files yet — upload one, or drop files here later.</p>'; return; }
    list.innerHTML = '';
    for (const f of files) {
      const row = el(`<div class="access-row" style="justify-content:space-between"><span class="link-chip">${esc(f.name)} <span class="stat-note">${fmtSize(f.size)}</span></span></div>`);
      const btns = el('<span></span>');
      const dl = el('<button class="btn small">Download</button>');
      dl.addEventListener('click', () => { const a = document.createElement('a'); a.href = `/api/machines/${encodeURIComponent(name)}/files/${encodeURIComponent(f.name)}`; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); });
      const del = el('<button class="btn small danger">Delete</button>');
      del.addEventListener('click', async () => {
        const c = await confirmModal({ title: 'Delete file', msg: `Delete “${f.name}” from ${name}? This cannot be undone.`, okLabel: 'Delete' });
        if (!c.ok) return;
        del.disabled = true;
        const r = await api.del(`/api/machines/${encodeURIComponent(name)}/files/${encodeURIComponent(f.name)}`);
        if (r.ok) refresh(); else { toast('err', friendlyError(r.data, `Could not delete ${f.name}`)); del.disabled = false; }
      });
      btns.append(dl, del);
      row.appendChild(btns);
      list.appendChild(row);
    }
  }

  async function uploadFile(file) {
    if (!file) return;
    err.textContent = '';
    if (file.size > 200 * 1024 * 1024) { err.textContent = 'File is larger than the 200 MB limit.'; return; }
    const label = panel.querySelector('label.btn'); const prev = label.textContent; label.textContent = 'Uploading…';
    try {
      const r = await fetch(`/api/machines/${encodeURIComponent(name)}/files/${encodeURIComponent(file.name)}`, { method: 'POST', body: file, cache: 'no-store' });
      if (r.ok) { toast('ok', `Uploaded ${file.name}`); refresh(); }
      else {
        const d = await r.json().catch(() => null);
        // Friendly, code-free messages — never surface a raw HTTP status.
        const fallback = r.status === 413 ? 'That file is too large to upload.'
          : r.status === 429 ? 'Too many actions — wait a moment and try again.'
          : r.status === 404 ? 'This machine is no longer available.'
          : 'Upload failed. Please try again.';
        err.textContent = friendlyError(d, fallback);
      }
    } catch { err.textContent = 'Upload failed — connection error.'; }
    finally { label.textContent = prev; }
  }

  panel.querySelector('#file-input').addEventListener('change', async (ev) => {
    await uploadFile(ev.target.files?.[0]);
    ev.target.value = '';
  });

  // Drag-and-drop upload onto the modal body (the empty state promises this).
  const dropZone = panel.querySelector('.confirm-body');
  dropZone.addEventListener('dragover', (ev) => { ev.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', async (ev) => {
    ev.preventDefault(); dropZone.classList.remove('drag-over');
    const file = ev.dataTransfer?.files?.[0];
    if (file) await uploadFile(file);
  });

  refresh();
}

// ---- Manage-access modal (admin) -------------------------------------------
async function openAccessModal(name) {
  const [usersRes, accessRes] = await Promise.all([api.get('/api/users'), api.get(`/api/machines/${encodeURIComponent(name)}/access`)]);
  if (usersRes.handled || accessRes.handled) return;
  if (!usersRes.ok || !accessRes.ok) { toast('err', friendlyError(usersRes.data || accessRes.data, 'Could not load access')); return; }
  const owner = accessRes.data.owner;
  const shared = new Set(accessRes.data.sharedWith || []);
  const candidates = usersRes.data.users.filter((u) => u.username !== owner && !u.disabled && u.role !== 'admin');

  const modal = el('<div class="overlay" data-overlay></div>');
  const rows = candidates.map((u) => `<label class="check-row"><input type="checkbox" value="${esc(u.username)}" ${shared.has(u.username) ? 'checked' : ''}/> <span>${esc(u.username)}</span></label>`).join('') || '<p class="stat-note">No other users to share with. Create users first.</p>';
  const panel = el(`<div class="modal small" role="dialog" aria-modal="true">
    <div class="overlay-head"><span class="overlay-title">Share “${esc(name)}”</span><span class="spacer"></span><button class="btn ghost" data-x>Close ✕</button></div>
    <div class="confirm-body"><p class="stat-note">Owner <b>${esc(owner)}</b> always has access. Pick who else can see and use it (they cannot delete it).</p><div class="access-list">${rows}</div><div class="form-error" id="acc-err"></div></div>
    <div class="confirm-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-save>Save access</button></div>
  </div>`);
  modal.appendChild(panel);
  document.body.appendChild(modal);
  const close = () => { closeDialog(modal); modal.remove(); };
  panel.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
  panel.querySelector('[data-save]').addEventListener('click', async () => {
    const sel = [...panel.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
    const res = await api.put(`/api/machines/${encodeURIComponent(name)}/access`, { sharedWith: sel });
    if (res.handled) { close(); return; }
    if (!res.ok) { panel.querySelector('#acc-err').textContent = friendlyError(res.data, 'Save failed'); return; }
    close(); toast('ok', `Access updated for ${name}`); store.requestPoll?.();
  });
  openDialog(modal, { initialFocus: '[data-save]' });
}
