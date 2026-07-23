// Admin console: tabs (My machines / All machines / Users / System).
import { api, friendlyError } from '../api.js';
import { store } from '../store.js';
import { $, el, esc, toast, copyText, confirmModal, openDialog, closeDialog } from '../ui.js';
import { renderMachines } from './machines.js';
import { renderResources } from './resources.js';

// Single tab registry. Admins get all tabs; regular users get their machines +
// the Resources view (with a reduced, own-machines-only payload from the server).
const ADMIN_TABS = [
  { id: 'mine', label: 'My machines' },
  { id: 'all', label: 'All machines' },
  { id: 'resources', label: 'Resources' },
  { id: 'usage', label: 'Usage' },
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit' },
  { id: 'system', label: 'System' },
];
const USER_TABS = [
  { id: 'mine', label: 'My machines' },
  { id: 'resources', label: 'Resources' },
];
function tabsFor() { return store.user?.role === 'admin' ? ADMIN_TABS : USER_TABS; }
const tabIds = () => tabsFor().map((t) => t.id);

export function renderNavTabs() {
  const nav = $('#nav-tabs');
  nav.classList.remove('hidden');
  nav.innerHTML = '';
  for (const t of tabsFor()) {
    const active = currentTab() === t.id;
    nav.appendChild(el(`<button class="nav-tab ${active ? 'active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`));
  }
}

// Hash scheme: '' = mine; admins use '#admin/<tab>', users use '#<tab>'.
export function currentTab() {
  const raw = (location.hash || '').replace(/^#/, '').replace(/^admin\//, '');
  return tabIds().includes(raw) ? raw : 'mine';
}

export function renderAdminView(root) {
  renderNavTabs();
  const tab = currentTab();
  const admin = store.user?.role === 'admin';
  if (tab === 'resources') renderResources(root, { admin });
  else if (tab === 'all' && admin) renderMachines(root, { showCreate: false, showOwner: true, title: 'All machines' });
  else if (tab === 'usage' && admin) renderUsage(root);
  else if (tab === 'users' && admin) renderUsers(root);
  else if (tab === 'audit' && admin) renderAudit(root);
  else if (tab === 'system' && admin) renderSystem(root);
  else renderMachines(root, { showCreate: true, title: admin ? 'My machines' : 'Your machines', ownerScope: admin ? store.user.username : null });
}

// ---- Usage & analytics tab (admin) -----------------------------------------
// Session-based analytics: WHO used WHICH machine and for HOW LONG, over a
// selectable window. Host resource metrics stay below for capacity context.
let usageDays = 30;
function renderUsage(root) {
  if (!root.querySelector('#usage-analytics')) {
    root.innerHTML = '';
    const sec = el('<section class="admin-section"></section>');
    const head = el('<div class="admin-head"></div>');
    head.appendChild(el('<h2 class="section-title">Usage &amp; analytics</h2>'));
    const range = el(`<select class="select" id="usage-range" style="max-width:170px">
      <option value="7">Last 7 days</option>
      <option value="30">Last 30 days</option>
      <option value="90">Last 90 days</option>
      <option value="365">Last 12 months</option>
    </select>`);
    range.value = String(usageDays);
    range.addEventListener('change', () => { usageDays = parseInt(range.value, 10) || 30; loadUsage(root); });
    head.appendChild(range);
    sec.appendChild(head);
    sec.appendChild(el('<div id="usage-analytics"><p class="stat-note">Loading…</p></div>'));
    root.appendChild(sec);
  }
  loadUsage(root);
}
function subTitle(t) { return `<h3 class="section-title" style="font-size:15px;margin:22px 0 8px">${esc(t)}</h3>`; }
function humanDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}
function hoursBar(hours, max) {
  const pct = Math.max(2, Math.min(100, Math.round((hours / (max || 1)) * 100)));
  return `<div style="display:flex;align-items:center;gap:8px">
    <span style="flex:0 0 52px;text-align:right">${hours}h</span>
    <span style="flex:1;height:8px;border-radius:4px;background:var(--border);overflow:hidden;display:block">
      <span style="display:block;height:100%;width:${pct}%;background:var(--accent);border-radius:4px"></span>
    </span>
  </div>`;
}
function dailyChart(daily) {
  if (!daily.length) return '<p class="chart-empty">No usage in this range.</p>';
  const W = 640, H = 80, n = daily.length;
  const max = Math.max(1, ...daily.map((d) => d.hours));
  const bw = W / n;
  const bars = daily.map((d, i) => {
    const bh = (d.hours / max) * (H - 4);
    return `<rect x="${(i * bw).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="var(--accent)" rx="1"><title>${esc(d.date)}: ${d.hours}h</title></rect>`;
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily usage hours">${bars}</svg>`;
}
async function loadUsage(root) {
  const holder = root.querySelector('#usage-analytics');
  if (!holder) return;
  const [a, m] = await Promise.all([api.get(`/api/analytics?days=${usageDays}`), api.get('/api/metrics?points=120')]);
  if (a.handled || m.handled || !root.querySelector('#usage-analytics')) return;
  if (!a.ok) { holder.innerHTML = `<p class="stat-note">${esc(friendlyError(a.data, 'Could not load analytics'))}</p>`; return; }
  const d = a.data; const t = d.totals || {};
  const tiles = [
    ['Total time', `${t.hours || 0}h`, `over ${d.range?.days || usageDays} days`],
    ['Active now', String(t.activeNow || 0), `${t.activeUsers || 0} user(s) online`],
    ['Users', String(t.users || 0), 'with sessions'],
    ['Machines', String(t.machines || 0), 'used'],
    ['Avg session', humanDur(t.avgSessionSec || 0), `${t.sessions || 0} sessions`],
    ['Peak concurrent', String(t.peakConcurrency || 0), 'sessions at once'],
  ].map(([l, v, s]) => `<div class="res-tile"><div class="res-tile-label">${esc(l)}</div><div class="res-tile-value">${esc(v)}</div><div class="res-tile-sub">${esc(s)}</div></div>`).join('');

  const active = d.active || [];
  const activeRows = active.length
    ? active.map((s) => `<tr><td>${esc(s.user)}</td><td class="mono">${esc(s.machine)}</td><td class="stat-note">${esc(s.template || '—')}</td><td>${humanDur(s.durationSec)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="stat-note">No one is connected right now.</td></tr>';

  const maxUserH = Math.max(1, ...(d.byUser || []).map((u) => u.hours));
  const userRows = (d.byUser || []).length
    ? d.byUser.map((u) => `<tr><td>${esc(u.user)}</td><td>${hoursBar(u.hours, maxUserH)}</td><td>${u.sessions}</td><td>${u.machines}</td><td class="stat-note">${u.lastAt ? esc(new Date(u.lastAt).toLocaleString()) : '—'}</td></tr>`).join('')
    : '<tr><td colspan="5" class="stat-note">No usage recorded yet.</td></tr>';

  const maxMachH = Math.max(1, ...(d.byMachine || []).map((mm) => mm.hours));
  const machRows = (d.byMachine || []).length
    ? d.byMachine.map((mm) => `<tr><td class="mono">${esc(mm.machine)}</td><td class="stat-note">${esc(mm.template || '—')}</td><td>${hoursBar(mm.hours, maxMachH)}</td><td>${mm.sessions}</td><td>${mm.users}</td><td class="stat-note">${esc(mm.owner || '—')}</td></tr>`).join('')
    : '<tr><td colspan="6" class="stat-note">No usage recorded yet.</td></tr>';

  let metricsHtml = '';
  if (m.ok) {
    const latest = m.data.latest || {}; const series = m.data.series || [];
    const memPct = latest.memTotal ? Math.round((latest.memUsed / latest.memTotal) * 100) : 0;
    const diskPct = latest.diskTotal ? Math.round((latest.diskUsed / latest.diskTotal) * 100) : 0;
    const rTiles = [['Memory', `${memPct}%`, 'of VM'], ['CPU', `${Math.round(latest.cpuPct || 0)}%`, 'across machines'], ['Disk', `${diskPct}%`, 'used'], ['Running', String(latest.running || 0), 'machines']]
      .map(([l, v, s]) => `<div class="res-tile"><div class="res-tile-label">${l}</div><div class="res-tile-value">${v}</div><div class="res-tile-sub">${s}</div></div>`).join('');
    metricsHtml = `${subTitle('Host resources')}<div class="res-tiles">${rTiles}</div>
      <div class="chart-card"><div class="chart-title">Memory used — recent (per minute)</div><div class="chart-holder">${sparkline(series.map((p) => (p.memTotal ? (p.memUsed / p.memTotal) * 100 : 0)))}</div></div>`;
  }

  holder.innerHTML = `
    <div class="res-tiles">${tiles}</div>
    <div class="chart-card"><div class="chart-title">Daily usage (hours)</div><div class="chart-holder">${dailyChart(d.daily || [])}</div></div>
    ${subTitle('Currently active')}
    <div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Machine</th><th>Type</th><th>Elapsed</th></tr></thead><tbody>${activeRows}</tbody></table></div>
    ${subTitle('By user')}
    <div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Time</th><th>Sessions</th><th>Machines</th><th>Last active</th></tr></thead><tbody>${userRows}</tbody></table></div>
    ${subTitle('By machine')}
    <div class="table-wrap"><table class="table"><thead><tr><th>Machine</th><th>Type</th><th>Time</th><th>Sessions</th><th>Users</th><th>Owner</th></tr></thead><tbody>${machRows}</tbody></table></div>
    ${metricsHtml}
  `;
}
function sparkline(vals) {
  if (!vals.length) return '<p class="chart-empty">No history yet — samples once a minute.</p>';
  const W = 640, H = 60;
  const step = vals.length > 1 ? W / (vals.length - 1) : W;
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(H - (Math.min(100, Math.max(0, v)) / 100) * H).toFixed(1)}`).join(' ');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Memory percent over time"><polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${pts}"/></svg>`;
}

// ---- Audit tab -------------------------------------------------------------
// Cached so the 4s poll does not refetch on every render; refreshed on tab entry
// (stale > 8s). Read-only view of privileged actions.
const auditCache = { data: null, at: 0, inflight: false };
function renderAudit(root) {
  if (!root.querySelector('#audit-tbody')) {
    root.innerHTML = '';
    const sec = el('<section class="machines-section"></section>');
    sec.appendChild(el('<h2 class="section-title">Audit log</h2>'));
    sec.appendChild(el('<p class="stat-note">Recent privileged actions — sign-ins, user &amp; machine changes, sharing, and VM control. Newest first.</p>'));
    sec.appendChild(el('<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th></tr></thead><tbody id="audit-tbody"><tr><td colspan="5" class="stat-note">Loading…</td></tr></tbody></table></div>'));
    root.appendChild(sec);
  }
  const paint = () => {
    const tb = root.querySelector('#audit-tbody'); if (!tb) return;
    const entries = auditCache.data;
    if (!entries) return;
    if (!entries.length) { tb.innerHTML = '<tr><td colspan="5" class="stat-note">No audit events yet.</td></tr>'; return; }
    tb.innerHTML = '';
    for (const e of entries) {
      const when = e.ts ? new Date(e.ts).toLocaleString() : '';
      const detail = e.detail != null ? (typeof e.detail === 'object' ? JSON.stringify(e.detail) : String(e.detail)) : '';
      const cls = /fail/.test(e.action || '') ? 'badge danger-badge' : 'badge';
      tb.appendChild(el(`<tr><td class="stat-note">${esc(when)}</td><td>${esc(e.actor || '—')}</td><td><span class="${cls}">${esc(e.action || '')}</span></td><td>${esc(e.target || '—')}</td><td class="stat-note">${esc(detail)}</td></tr>`));
    }
  };
  paint();
  if (!auditCache.inflight && Date.now() - auditCache.at > 8000) {
    auditCache.inflight = true;
    api.get('/api/audit?limit=200').then((res) => {
      auditCache.inflight = false;
      if (res.handled) return;
      if (res.ok) { auditCache.data = res.data.entries || []; auditCache.at = Date.now(); }
      else if (!auditCache.data) { const tb = root.querySelector('#audit-tbody'); if (tb) tb.innerHTML = `<tr><td colspan="5" class="stat-note">${esc(friendlyError(res.data, 'Could not load the audit log'))}</td></tr>`; }
      paint();
    }).catch(() => { auditCache.inflight = false; });
  }
}

// ---- Users tab -------------------------------------------------------------
// Cache the list so the 4s poll does not refetch/flicker the table mid-click.
// Refetched only on tab entry (stale >8s) or after a mutation (invalidateUsers).
const usersCache = { data: null, at: 0, inflight: false };
function invalidateUsers() { usersCache.at = 0; }

function renderUsers(root) {
  root.innerHTML = '';
  const sec = el('<section class="admin-section"></section>');
  const head = el('<div class="admin-head"></div>');
  head.appendChild(el('<h2 class="section-title">Users</h2>'));
  const createBtn = el('<button class="btn primary" id="create-user-btn">Create user</button>');
  createBtn.addEventListener('click', openCreateUser);
  head.appendChild(createBtn);
  sec.appendChild(head);
  const wrap = el('<div class="table-wrap"><table class="table"><thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Machines</th><th>Actions</th></tr></thead><tbody id="users-tbody"></tbody></table></div>');
  sec.appendChild(wrap);
  root.appendChild(sec);

  if (usersCache.data) drawUsers(usersCache.data);
  else $('#users-tbody').innerHTML = '<tr><td colspan="5">Loading…</td></tr>';

  if (Date.now() - usersCache.at > 8000 && !usersCache.inflight) {
    usersCache.inflight = true;
    api.get('/api/users').then((res) => {
      usersCache.inflight = false;
      if (res.handled) return;
      if (!res.ok) { const tb = $('#users-tbody'); if (tb) tb.innerHTML = `<tr><td colspan="5">${esc(friendlyError(res.data, 'Failed to load users'))}</td></tr>`; return; }
      usersCache.data = res.data.users; usersCache.at = Date.now();
      if (currentTab() === 'users' && $('#users-tbody')) drawUsers(usersCache.data);
    });
  }
}

function drawUsers(users) {
  const tb = $('#users-tbody');
  if (!tb) return;
  const activeAdmins = users.filter((u) => u.role === 'admin' && !u.disabled).length;
  tb.innerHTML = '';
  for (const u of users) {
    const isLastAdmin = u.role === 'admin' && !u.disabled && activeAdmins === 1;
    const isSelf = u.username === store.user.username;
    const tr = el(`<tr data-user="${esc(u.username)}">
      <td class="mono">${esc(u.username)}${isSelf ? ' <span class="tag">you</span>' : ''}</td>
      <td>${u.role}${u.mustChangePassword ? ' <span class="tag">must change pw</span>' : ''}</td>
      <td>${u.disabled ? '<span class="tag off">disabled</span>' : '<span class="tag on">active</span>'}</td>
      <td>${u.machines.running}/${u.machines.total}</td>
      <td class="row-actions"></td>
    </tr>`);
    const actions = tr.querySelector('.row-actions');
    actions.appendChild(mkBtn('Reset password', () => resetPassword(u.username)));
    actions.appendChild(mkBtn(u.disabled ? 'Enable' : 'Disable', () => toggleDisabled(u.username, !u.disabled), isLastAdmin && !u.disabled));
    actions.appendChild(mkBtn(u.role === 'admin' ? 'Make user' : 'Make admin', () => toggleRole(u.username, u.role === 'admin' ? 'user' : 'admin'), isLastAdmin && u.role === 'admin'));
    actions.appendChild(mkBtn('Delete', () => deleteUser(u.username, u.machines.total), isLastAdmin || isSelf, true));
    tb.appendChild(tr);
  }
}

function mkBtn(label, fn, disabled = false, danger = false) {
  const b = el(`<button class="btn small ${danger ? 'danger' : ''}" ${disabled ? 'disabled title="Not allowed"' : ''}>${esc(label)}</button>`);
  if (!disabled) b.addEventListener('click', fn);
  return b;
}

function genPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const arr = new Uint32Array(16); crypto.getRandomValues(arr);
  return [...arr].map((n) => chars[n % chars.length]).join('');
}

function openCreateUser() {
  const pw = genPassword();
  $('#confirm-title'); // ensure ui loaded
  const overlay = $('#credential');
  // Reuse a lightweight inline form via confirmModal is awkward; build a dedicated modal.
  const body = el(`<div class="modal small" role="dialog" aria-modal="true">
    <div class="overlay-head"><span class="overlay-title">Create user</span><span class="spacer"></span><button class="btn ghost" data-x>Close ✕</button></div>
    <form class="confirm-body" id="cu-form">
      <label>Username</label>
      <input class="text-input" id="cu-user" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="lowercase, 3–32 chars" />
      <label>Role</label>
      <select class="select" id="cu-role"><option value="user">User</option><option value="admin">Admin</option></select>
      <label>Initial password</label>
      <div class="pw-gen-row"><input class="text-input mono" id="cu-pass" value="${esc(pw)}" /><button type="button" class="btn small" id="cu-regen">Regenerate</button></div>
      <div class="form-error" id="cu-error" role="alert"></div>
    </form>
    <div class="confirm-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" id="cu-submit">Create</button></div>
  </div>`);
  const modal = el('<div class="overlay" data-overlay></div>');
  modal.appendChild(body);
  document.body.appendChild(modal);
  // Pop the focus-trap stack AND remove the node — a bare remove() would orphan
  // the dialogStack entry and break Tab/Esc for every later dialog.
  const close = () => { closeDialog(modal); modal.remove(); };
  body.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', close));
  body.querySelector('#cu-regen').addEventListener('click', () => { body.querySelector('#cu-pass').value = genPassword(); });
  body.querySelector('#cu-submit').addEventListener('click', async () => {
    const username = body.querySelector('#cu-user').value.trim().toLowerCase();
    const role = body.querySelector('#cu-role').value;
    const password = body.querySelector('#cu-pass').value;
    const res = await api.post('/api/users', { username, password, role });
    if (res.handled) { close(); return; }
    if (!res.ok) { body.querySelector('#cu-error').textContent = friendlyError(res.data, 'Could not create user'); return; }
    close();
    showCredential('User created', username, password);
    invalidateUsers();
    store.rerender?.();
  });
  openDialog(modal, { initialFocus: '#cu-user' });
}

function showCredential(title, username, password) {
  $('#credential-title').textContent = title;
  $('#credential-box').innerHTML = `<div><span class="cred-label">Username</span> <span class="mono">${esc(username)}</span></div><div><span class="cred-label">Password</span> <span class="mono">${esc(password)}</span></div>`;
  $('#credential-copy').onclick = () => copyText(`${username}\n${password}`, 'Username & password copied');
  $('#credential-done').onclick = () => closeDialog($('#credential'));
  openDialog($('#credential'), { initialFocus: '#credential-copy' });
}

async function resetPassword(username) {
  const conf = await confirmModal({ title: `Reset password for ${username}?`, msg: 'A new password will be generated and shown once. Their existing sessions will be signed out.', okLabel: 'Reset password' });
  if (!conf.ok) return;
  const password = genPassword();
  const res = await api.patch(`/api/users/${encodeURIComponent(username)}`, { password });
  if (res.handled) return;
  if (!res.ok) { toast('err', friendlyError(res.data, 'Reset failed')); return; }
  showCredential('Password reset', username, password);
  invalidateUsers();
  store.rerender?.();
}

async function toggleDisabled(username, disabled) {
  const res = await api.patch(`/api/users/${encodeURIComponent(username)}`, { disabled });
  if (res.handled) return;
  if (res.ok) { toast('ok', `${disabled ? 'Disabled' : 'Enabled'} ${username}`); invalidateUsers(); store.rerender?.(); }
  else toast('err', friendlyError(res.data, 'Update failed'));
}
async function toggleRole(username, role) {
  const res = await api.patch(`/api/users/${encodeURIComponent(username)}`, { role });
  if (res.handled) return;
  if (res.ok) { toast('ok', `${username} is now ${role}`); invalidateUsers(); store.rerender?.(); }
  else toast('err', friendlyError(res.data, 'Update failed'));
}
async function deleteUser(username, machineCount) {
  const conf = await confirmModal({
    title: `Delete ${username}?`,
    msg: `Permanently remove the account “${username}”.`,
    typed: username,
    checkboxLabel: machineCount > 0 ? `Also delete their ${machineCount} machine(s)` : null,
  });
  if (!conf.ok) return;
  const res = await api.del(`/api/users/${encodeURIComponent(username)}`, { deleteMachines: !!conf.checked });
  if (res.handled) return;
  if (res.ok) { toast('ok', `Deleted ${username}`); invalidateUsers(); store.rerender?.(); }
  else toast('err', friendlyError(res.data, 'Delete failed'));
}

// ---- System tab ------------------------------------------------------------
function renderSystem(root) {
  root.innerHTML = '';
  const st = store.state; const vm = st.vm || {};
  const sec = el('<section class="admin-section"></section>');
  sec.appendChild(el('<h2 class="section-title">System</h2>'));

  let label = 'Stopped'; let dot = 'stopped'; let busy = false;
  if (vm.transition === 'starting') { label = `Starting… ${Math.round(vm.elapsedMs / 1000)}s`; dot = 'busy'; busy = true; }
  else if (vm.transition === 'stopping') { label = `Stopping… ${Math.round(vm.elapsedMs / 1000)}s`; dot = 'busy'; busy = true; }
  else if (vm.running) { label = 'Running'; dot = 'running'; }

  const specs = vm.cpu ? `${vm.cpu} CPU · ${vm.memoryGiB} GiB RAM · ${vm.diskGiB} GiB disk · ${vm.arch || ''}` : '';
  const card = el(`<div class="panel-card">
    <div class="panel-card-head"><span class="dot ${dot}"></span> <b>Virtual machine: ${esc(label)}</b></div>
    <div class="panel-card-sub">${esc(specs)}</div>
    <div class="panel-card-actions">
      <button class="btn primary" id="vm-start" ${busy || vm.running ? 'disabled' : ''}>Start VM</button>
    </div>
  </div>`);
  sec.appendChild(card);

  const danger = el(`<div class="panel-card danger-zone">
    <div class="panel-card-head"><b>Danger zone</b></div>
    <div class="panel-card-sub">Stopping the VM stops every machine for all users.</div>
    <div class="panel-card-actions"><button class="btn danger" id="vm-stop" ${busy || !vm.running ? 'disabled' : ''}>Stop VM</button></div>
  </div>`);
  sec.appendChild(danger);
  root.appendChild(sec);

  card.querySelector('#vm-start')?.addEventListener('click', () => vmAction('start'));
  danger.querySelector('#vm-stop')?.addEventListener('click', () => vmAction('stop'));
}

async function vmAction(action) {
  if (action === 'stop') {
    const conf = await confirmModal({ title: 'Stop the VM?', msg: 'This stops every machine for all users. You can start it again anytime.', okLabel: 'Stop VM' });
    if (!conf.ok) return;
  }
  const res = await api.post(`/api/vm/${action}`);
  if (res.handled) return;
  if (res.ok) { toast('info', `VM ${action === 'start' ? 'starting' : 'stopping'}…`, 'This usually takes 30–90 seconds.'); store.requestPoll?.(); }
  else toast('err', friendlyError(res.data, `VM ${action} failed`));
}
