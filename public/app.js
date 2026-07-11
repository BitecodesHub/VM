// PRISM Virtual Desktop entry point: boot, view router, polling, topbar, global wiring.
import { api } from './js/api.js';
import { setUnauthorizedHandler } from './js/api.js';
import { store, reset } from './js/store.js';
import { $, $$, el, esc, showView, toast, closeDialog, topDialog, setFavicon, setTitle, closeAllDialogs } from './js/ui.js';
import { resolveConfirm } from './js/ui.js';
import { initAuth, showLoginNotice } from './js/views/auth.js';
import { renderAdminView, currentTab } from './js/views/admin.js';
import { handleMachineClick, closeViewer, closeLogs, refreshLogs } from './js/views/machines.js';
import { stopResources } from './js/views/resources.js';
import { isStatsPopOpen, closeStatsPop } from './js/stats-pop.js';

const POLL_MS = 4000;

// ---- Poller (generation token so it stops cleanly on logout/401) -----------
const poller = {
  gen: 0,
  start() { const g = ++this.gen; const tick = () => poll().finally(() => { if (g === this.gen) setTimeout(tick, document.hidden ? 15000 : POLL_MS); }); tick(); },
  stop() { this.gen++; },
};
store.requestPoll = () => poll();
store.rerender = () => { if (store.user) renderApp(); };

// ---- 401 handling ----------------------------------------------------------
setUnauthorizedHandler(() => {
  poller.stop();
  const wasIn = !!store.user;
  reset();
  closeAllDialogs(); // dismiss EVERY modal (incl. dynamic ones) so none is left over the login screen
  resolveConfirm(false);
  closeStatsPop();
  stopResources();
  $('#viewer-frame').src = 'about:blank';
  showLoginNotice(wasIn ? 'Your session expired. Please sign in again.' : '');
  showView('login');
  setFavicon('normal'); setTitle('PRISM Virtual Desktop');
});

// ---- Boot ------------------------------------------------------------------
async function boot() {
  showView('loading');
  const res = await api.get('/api/me');
  if (res.offline) {
    // Transient server blip (restart / network) — DON'T eject a possibly-valid
    // session to login. Stay on the loading view, show a reconnecting note, and
    // retry; boot() resolves normally once the server answers (session intact).
    const note = $('#loading-note');
    if (note) { note.textContent = 'Reconnecting to the server…'; note.classList.remove('hidden'); }
    setTimeout(boot, 3000);
    return;
  }
  if (res.status === 409) { showView('setup'); return; }
  if (res.handled) return;              // 401 → onUnauthorized already showed login
  if (res.ok) {
    store.user = res.data;
    if (res.data.mustChangePassword) { showView('forced-change'); return; }
    enterApp();
  }
}

async function enterApp() {
  showLoginNotice('');
  showView('app');
  // Load the create-tile template list once (drives the create tiles).
  if (!store.templates) { const t = await api.get('/api/templates'); if (t.ok) store.templates = t.data; }
  renderTopbar();
  renderApp();
  poller.start();
}

// ---- Polling ---------------------------------------------------------------
async function poll() {
  const res = await api.get('/api/state');
  if (res.handled) return;
  if (res.offline) { showBanner('offline', 'Cannot reach the PRISM Virtual Desktop server.', true); setFavicon('red'); setTitle('PRISM Virtual Desktop — offline'); return; }
  if (!res.ok) return;
  store.state = res.data;
  store.user = res.data.user;
  renderApp();
  const vm = res.data.vm;
  if (!vm.running) { setFavicon('grey'); setTitle('PRISM Virtual Desktop — VM stopped'); }
  else { setFavicon('normal'); const n = (res.data.machines || []).filter((m) => m.state === 'running').length; setTitle(n ? `PRISM Virtual Desktop — ${n} running` : 'PRISM Virtual Desktop'); }
}

// ---- Render ----------------------------------------------------------------
function renderApp() {
  if (!store.state) return;
  renderTopbar();
  renderBanner();
  renderAdminView($('#view-root'));
}

function renderTopbar() {
  const u = store.user; if (!u) return;
  $('#account-name').textContent = u.username;
  $('#avatar').textContent = (u.username[0] || '?').toUpperCase();
  $('#menu-head').textContent = `${u.username} · ${u.role}`;
  const chip = $('#quota-chip');
  const q = store.state?.quota;
  if (q) { chip.textContent = `${q.used} of ${q.limit} running`; chip.classList.toggle('full', q.used >= q.limit); chip.classList.remove('hidden'); }
  else chip.classList.add('hidden');
  const addr = store.state?.panel;
  if (addr) $('#help-addr').innerHTML = `Reach this panel at <code>http://${esc(addr.lanHost || 'localhost')}:${addr.port}</code>${addr.version ? ` · v${esc(addr.version)}` : ''}`;
}

function renderBanner() {
  const vm = store.state?.vm || {};
  const isAdmin = store.user?.role === 'admin';
  const failed = vm.lastResult && !vm.lastResult.ok ? vm.lastResult : null;
  // Critical capacity/health alerts take precedence over routine VM banners.
  const alerts = store.state?.alerts || [];
  const crit = alerts.find((a) => a.level === 'critical' && a.id !== 'vm-down');
  const warn = alerts.find((a) => a.level === 'warning');
  if (crit) return showBanner('offline', `⚠ ${crit.title}`);
  if (vm.transition) showBanner('', `The VM is ${vm.transition}… machine actions are paused for a moment.`);
  else if (failed) {
    const verb = failed.kind === 'starting' ? 'start' : 'stop';
    const why = failed.timedOut ? 'it timed out' : (isAdmin && failed.message ? failed.message : 'it reported an error');
    showBanner('offline', `The VM failed to ${verb}: ${why}.${isAdmin ? ' You can retry from the System tab.' : ' An administrator can retry.'}`);
  }
  else if (!vm.running) showBanner('', isAdmin ? 'The VM is stopped. Start it from the System tab to use machines.' : 'The VM is stopped — machines are unavailable. An administrator can start it.');
  else if (warn) showBanner('', `⚠ ${warn.title}`);
  else $('#banner').classList.add('hidden');
}

function showBanner(cls, text, retry = false) {
  const b = $('#banner');
  b.className = `banner ${cls}`;
  b.innerHTML = `<span>${esc(text)}</span>`;
  if (retry) { const btn = el('<button class="btn small">Retry</button>'); btn.addEventListener('click', () => poll()); b.appendChild(btn); }
  b.classList.remove('hidden');
}

// ---- Global wiring ---------------------------------------------------------
initAuth({ onLoggedIn: boot });

$('#view-root').addEventListener('click', handleMachineClick);

// Nav tabs (event delegation). Admins use #admin/<tab>, users use #<tab>.
$('#nav-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  const id = tab.dataset.tab;
  const prefix = store.user?.role === 'admin' ? 'admin/' : '';
  location.hash = id === 'mine' ? '' : `${prefix}${id}`;
  renderApp();
});
window.addEventListener('hashchange', () => { if (store.user) renderApp(); });

// Account menu.
$('#account-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('#account-menu');
  const open = m.classList.toggle('hidden');
  $('#account-btn').setAttribute('aria-expanded', String(!open));
  if (!open) { const r = $('#account-btn').getBoundingClientRect(); m.style.top = `${r.bottom + 6}px`; m.style.right = `${window.innerWidth - r.right}px`; }
});
$('#menu-logout').addEventListener('click', async () => {
  $('#account-menu').classList.add('hidden');
  poller.stop();
  stopResources();
  await api.post('/api/logout');
  reset();
  showLoginNotice('');
  showView('login');
  setFavicon('normal'); setTitle('PRISM Virtual Desktop');
});
document.body.addEventListener('click', (e) => {
  if (!$('#account-menu').classList.contains('hidden') && !e.target.closest('#account-menu') && !e.target.closest('#account-btn')) $('#account-menu').classList.add('hidden');
  if (!$('#help').classList.contains('hidden') && !e.target.closest('#help') && !e.target.closest('#help-btn')) $('#help').classList.add('hidden');
});

// Help.
$('#help-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#help').classList.toggle('hidden'); });

// Viewer + logs.
$('#viewer-close').addEventListener('click', closeViewer);
$('#logs-close').addEventListener('click', closeLogs);
$('#logs-refresh').addEventListener('click', refreshLogs);
$('#logs-tail').addEventListener('change', refreshLogs);
$('#logs-copy').addEventListener('click', () => navigator.clipboard.writeText($('#logs-body').textContent).then(() => toast('ok', 'Logs copied')).catch(() => toast('err', 'Copy failed')));

// Keyboard: Esc closes the topmost dialog / menus.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (isStatsPopOpen()) return closeStatsPop();
  if (!$('#confirm').classList.contains('hidden')) return resolveConfirm(false);
  const top = topDialog();
  if (top === $('#viewer')) return closeViewer();
  if (top === $('#logs')) return closeLogs();
  if (top) return closeDialog(top);
  if (!$('#account-menu').classList.contains('hidden')) return $('#account-menu').classList.add('hidden');
  if (!$('#help').classList.contains('hidden')) return $('#help').classList.add('hidden');
});

// Re-poll promptly when returning to the tab.
document.addEventListener('visibilitychange', () => { if (!document.hidden && store.user) poll(); });

boot();
