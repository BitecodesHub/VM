// Per-machine resource popover (the ⓘ button). One body-appended element that
// survives the grid's 4s re-render; refreshes every 5s while open.
import { api, friendlyError } from './api.js';
import { $, el, esc } from './ui.js';
import { fmtBytes, fmtPct } from './charts.js';

let popEl = null;
let current = null;   // machine name
let timer = null;

function ensure() {
  if (popEl) return popEl;
  popEl = el(`<div id="stats-pop" class="stats-pop hidden" role="dialog" aria-label="Machine resources">
    <div class="stats-pop-head"><span class="stats-pop-title"></span><span class="spacer"></span><button class="btn ghost small" data-close aria-label="Close">✕</button></div>
    <div class="stats-pop-body"></div>
    <div class="stats-pop-foot"></div>
  </div>`);
  document.body.appendChild(popEl);
  popEl.querySelector('[data-close]').addEventListener('click', closeStatsPop);
  return popEl;
}

function meterLevel(pct) { return pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : ''; }

function renderBody(data) {
  const body = popEl.querySelector('.stats-pop-body');
  if (data.state !== 'running') {
    const oom = data.exitCode === 137 ? ' — likely killed for memory (exit 137)' : (data.exitCode != null ? ` — last exit ${data.exitCode}` : '');
    body.innerHTML = `<p class="stat-note">Machine is ${esc(data.state)}${esc(oom)}. Start it to see live usage.</p>`;
    popEl.querySelector('.stats-pop-foot').textContent = '';
    return;
  }
  const memPct = data.memPerc ?? (data.memUsedBytes && data.memLimitBytes ? (data.memUsedBytes / data.memLimitBytes) * 100 : 0);
  const cpu = data.cpuPerc ?? 0;
  body.innerHTML = `
    <div class="stat-row"><span class="stat-label">CPU</span><span class="stat-val">${fmtPct(cpu)} of a core</span></div>
    <div class="meter"><div class="meter-fill" style="width:${Math.min(100, cpu)}%"></div></div>
    <div class="stat-row"><span class="stat-label">RAM</span><span class="stat-val">${fmtBytes(data.memUsedBytes)} / ${fmtBytes(data.memLimitBytes)}</span></div>
    <div class="meter"><div class="meter-fill ${meterLevel(memPct)}" style="width:${Math.min(100, memPct)}%"></div></div>
    <div class="stat-row"><span class="stat-label">Disk</span><span class="stat-val">${fmtBytes(data.diskRwBytes)} writable</span></div>`;
  const ago = data.sampledAt ? Math.max(0, Math.round((Date.now() - Date.parse(data.sampledAt)) / 1000)) : null;
  popEl.querySelector('.stats-pop-foot').textContent = ago == null ? '' : `Updated ${ago}s ago${data.stale ? ' · last known' : ''}`;
}

async function refresh() {
  if (!current) return;
  const res = await api.get(`/api/machines/${encodeURIComponent(current)}/stats`);
  if (res.handled) { closeStatsPop(); return; }
  if (!popEl || popEl.classList.contains('hidden')) return;
  if (!res.ok) { popEl.querySelector('.stats-pop-body').innerHTML = `<p class="stat-note">${esc(friendlyError(res.data, 'Usage unavailable'))}</p>`; return; }
  renderBody(res.data);
}

export function openStatsPop(name, anchorEl) {
  ensure();
  current = name;
  popEl.querySelector('.stats-pop-title').textContent = name;
  popEl.querySelector('.stats-pop-body').innerHTML = '<p class="stat-note">Loading…</p>';
  popEl.querySelector('.stats-pop-foot').textContent = '';
  popEl.classList.remove('hidden');
  // Position: below the anchor, clamped to the viewport.
  const r = anchorEl.getBoundingClientRect();
  const width = Math.min(280, window.innerWidth - 24);
  popEl.style.width = width + 'px';
  let left = Math.min(r.left, window.innerWidth - width - 12);
  let top = r.bottom + 8;
  if (top + 200 > window.innerHeight) top = Math.max(12, r.top - 210);
  popEl.style.left = Math.max(12, left) + 'px';
  popEl.style.top = top + 'px';
  refresh();
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
}

export function closeStatsPop() {
  if (timer) { clearInterval(timer); timer = null; }
  current = null;
  if (popEl) popEl.classList.add('hidden');
}
export function isStatsPopOpen() { return !!popEl && !popEl.classList.contains('hidden'); }

// Close on outside click / scroll / resize.
document.addEventListener('click', (e) => {
  if (isStatsPopOpen() && !e.target.closest('#stats-pop') && !e.target.closest('[data-act="info"]')) closeStatsPop();
});
window.addEventListener('scroll', () => { if (isStatsPopOpen()) closeStatsPop(); }, true);
window.addEventListener('resize', () => { if (isStatsPopOpen()) closeStatsPop(); });
