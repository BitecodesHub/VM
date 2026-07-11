// Resources tab: capacity + usage, per-machine bar charts, disk composition.
// Real-time: the DOM skeleton is built ONCE, then a self-timer refreshes it IN
// PLACE (~2.5s) — mirroring stats-pop.js — so tiles, meters and charts update
// live without the old full-rebuild flicker or scroll reset. The server stats
// cache (~5s) is the true freshness floor; faster ticks mostly hit that cache.
// The timer stops itself when the view is unmounted (another tab replaced
// #view-root), while the tab is hidden, and on logout/401 (see stopResources).
import { api, friendlyError } from '../api.js';
import { store } from '../store.js';
import { el, esc } from '../ui.js';
import { fmtBytes, fmtPct, hBarChart, stackedBar } from '../charts.js';

const TICK_MS = 2500;
const cache = { data: null, at: 0, forUser: null, inflight: false, error: null };
const refs = {};
let dataTimer = null;
let agoTimer = null;
let mount = null; // the <section> sentinel; when detached from the DOM → teardown

function meterLevel(pct) { return pct >= 90 ? 'crit' : pct >= 80 ? 'warn' : ''; }
function clampPct(p) { return Math.min(100, Math.max(0, p || 0)); }

export function renderResources(root, { admin } = {}) {
  const u = store.user?.username;
  if (cache.forUser !== u) { cache.data = null; cache.at = 0; cache.forUser = u; }
  // Build the skeleton only on first mount / re-mount after a tab switch / role
  // change — never on every 4s poll, so in-place state and scroll are preserved.
  if (!mount || !mount.isConnected || mount.parentNode !== root || refs.admin !== !!admin) {
    buildSkeleton(root, !!admin);
  }
  ensureTimers();
  refresh();
}

// Called by app.js on logout/401 so the poller-independent timer never lingers.
export function stopResources() { stopTimers(); }

function ensureTimers() {
  if (!dataTimer) dataTimer = setInterval(tick, TICK_MS);
  if (!agoTimer) agoTimer = setInterval(paintAgo, 1000);
}
function stopTimers() {
  if (dataTimer) { clearInterval(dataTimer); dataTimer = null; }
  if (agoTimer) { clearInterval(agoTimer); agoTimer = null; }
}

function tick() {
  if (!mount || !mount.isConnected) { stopTimers(); return; } // view gone
  if (document.hidden) return;                                 // paused while backgrounded
  refresh();
}

function refresh() {
  if (!cache.inflight) {
    cache.inflight = true;
    api.get('/api/resources').then((res) => {
      cache.inflight = false;
      if (res.handled) { stopTimers(); return; } // 401 → app.js swaps the view
      if (res.ok) { cache.data = res.data; cache.at = Date.now(); cache.error = null; }
      else { cache.error = friendlyError(res.data, 'Could not load resource stats.'); }
      if (mount && mount.isConnected) paint();
    }).catch(() => { cache.inflight = false; cache.error = 'Cannot reach the server — retrying…'; if (mount && mount.isConnected) paint(); });
  }
  paint(); // reflect current cache immediately (skeleton "Loading…" on first entry)
}

// ---- Skeleton (built once) -------------------------------------------------
function buildSkeleton(root, admin) {
  root.innerHTML = '';
  const sec = el('<section class="admin-section"></section>');
  const title = el('<h2 class="section-title">Resources <span class="count" id="res-ago"></span></h2>');
  const warn = el('<div class="res-warn hidden"></div>');
  const empty = el('<p class="empty">Loading…</p>');
  sec.append(title, warn, empty);

  const tiles = el('<div class="res-tiles hidden"></div>');
  const memTile = tileSkeleton('Memory');
  const cpuTile = tileSkeleton('CPU');
  const diskTile = tileSkeleton('Disk');
  tiles.append(memTile.root, cpuTile.root, diskTile.root);
  sec.appendChild(tiles);

  const memCard = chartCardSkeleton('Memory by machine');
  const cpuCard = chartCardSkeleton('CPU by machine');
  sec.append(memCard.card, cpuCard.card);
  let diskCard = null;
  if (admin) {
    diskCard = chartCardSkeleton('Disk composition', {
      legend: true,
      caveat: 'As reported by Docker (whole VM, includes other containers & reclaimable cache).',
    });
    sec.appendChild(diskCard.card);
  }

  root.appendChild(sec);
  Object.assign(refs, { admin, title, ago: title.querySelector('#res-ago'), warn, empty, tiles, memTile, cpuTile, diskTile, memCard, cpuCard, diskCard });
  mount = sec;
}

function tileSkeleton(label) {
  const root = el(`<div class="res-tile"><div class="res-tile-label">${esc(label)}</div><div class="res-tile-value"></div><div class="meter"><div class="meter-fill"></div></div><div class="res-tile-sub"></div></div>`);
  return { root, value: root.querySelector('.res-tile-value'), fill: root.querySelector('.meter-fill'), sub: root.querySelector('.res-tile-sub') };
}
function chartCardSkeleton(title, { legend, caveat } = {}) {
  const card = el('<div class="chart-card"></div>');
  card.appendChild(el(`<div class="chart-title">${esc(title)}</div>`));
  const holder = el('<div class="chart-holder"></div>');
  card.appendChild(holder);
  const legendHolder = legend ? el('<div class="legend-holder"></div>') : null;
  if (legendHolder) card.appendChild(legendHolder);
  if (caveat) card.appendChild(el(`<p class="chart-caveat">${esc(caveat)}</p>`));
  return { card, holder, legend: legendHolder };
}

// ---- In-place paint --------------------------------------------------------
function paintAgo() {
  if (!refs.ago) return;
  const ago = cache.at ? Math.round((Date.now() - cache.at) / 1000) : null;
  refs.ago.textContent = ago != null ? `updated ${ago}s ago${cache.data?.stale?.stats ? ' · last known' : ''}` : '';
}

function showContent(vis) {
  refs.tiles.classList.toggle('hidden', !vis);
  refs.memCard.card.classList.toggle('hidden', !vis);
  refs.cpuCard.card.classList.toggle('hidden', !vis);
  if (refs.diskCard) refs.diskCard.card.classList.toggle('hidden', !vis);
}
function setTile(t, valueHtml, pct, sub) {
  t.value.innerHTML = valueHtml;
  t.fill.className = `meter-fill ${meterLevel(pct)}`;
  t.fill.style.width = `${clampPct(pct)}%`;
  t.sub.textContent = sub;
}

function paint() {
  if (!refs.title) return;
  paintAgo();
  const d = cache.data;
  if (!d) {
    // No data yet: show the error (if the first fetch failed) instead of a
    // permanent "Loading…"; it keeps retrying on the poll timer.
    refs.empty.textContent = cache.error || 'Loading…';
    refs.empty.classList.remove('hidden'); refs.warn.classList.add('hidden'); showContent(false); return;
  }
  if (!d.vmRunning) { refs.empty.textContent = 'The VM is stopped — start it to see live usage.'; refs.empty.classList.remove('hidden'); refs.warn.classList.add('hidden'); showContent(false); return; }
  refs.empty.classList.add('hidden');
  showContent(true);

  const cap = d.capacity, used = d.used, admin = refs.admin;
  const memPct = used.memPerc ?? 0;

  if (memPct >= 80) {
    refs.warn.className = `res-warn${memPct >= 90 ? ' crit' : ''}`;
    refs.warn.textContent = `⚠ Memory is ${fmtPct(memPct)} used. Machines can be killed when the VM runs out of memory — stop something you are not using.`;
  } else {
    refs.warn.classList.add('hidden');
  }

  const cpuPct = cap.cpuPerc ? (used.cpuPerc / cap.cpuPerc) * 100 : 0;
  const diskUsed = used.disk?.totalBytes, diskCap = cap.diskBytes;
  const diskFree = diskCap && diskUsed != null ? Math.max(0, diskCap - diskUsed) : null;
  setTile(refs.memTile, `${fmtBytes(used.memBytes)} <span class="muted">of ${fmtBytes(cap.memBytes)}</span>`, memPct, cap.provisionedMemBytes ? `${fmtBytes(cap.provisionedMemBytes)} provisioned` : '');
  setTile(refs.cpuTile, `${fmtPct(used.cpuPerc)} <span class="muted">of ${cap.cpu} cores</span>`, cpuPct, 'across all machines');
  setTile(refs.diskTile, `${fmtBytes(diskUsed)} <span class="muted">of ${fmtBytes(diskCap)}</span>`, diskCap ? (diskUsed / diskCap) * 100 : 0, diskFree != null ? `${fmtBytes(diskFree)} free` : '');

  const running = d.machines.filter((m) => m.state === 'running');
  const sumMem = running.reduce((a, m) => a + (m.memBytes || 0), 0);
  const otherMem = used.memBytes != null ? Math.max(0, used.memBytes - sumMem) : 0;

  const memRows = running.map((m) => ({
    label: m.name, sublabel: admin ? m.owner : null,
    value: m.memBytes || 0, valueText: fmtBytes(m.memBytes),
    level: meterLevel(m.memPerc || (cap.memBytes ? (m.memBytes / cap.memBytes) * 100 : 0)),
  })).sort((a, b) => b.value - a.value);
  if (otherMem > 16 * 1024 * 1024) memRows.push({ label: admin ? 'Other containers & system' : 'Other users & system', value: otherMem, valueText: fmtBytes(otherMem), level: '' });
  refs.memCard.holder.innerHTML = hBarChart({ rows: memRows, max: cap.memBytes || sumMem, ariaLabel: 'Memory used per machine' });

  const cpuRows = running.map((m) => ({ label: m.name, sublabel: admin ? m.owner : null, value: m.cpuPerc || 0, valueText: fmtPct(m.cpuPerc) })).sort((a, b) => b.value - a.value);
  refs.cpuCard.holder.innerHTML = hBarChart({ rows: cpuRows, max: cap.cpuPerc || 100, ariaLabel: 'CPU used per machine' });

  if (admin && refs.diskCard && used.disk) {
    const dk = used.disk;
    const free = diskFree || 0;
    const { svg, legend } = stackedBar({
      total: (dk.totalBytes || 0) + free,
      ariaLabel: 'Disk usage composition',
      segments: [
        { label: 'Images', value: dk.imagesBytes || 0, cls: 'seg-images' },
        { label: 'Containers', value: dk.containersBytes || 0, cls: 'seg-containers' },
        { label: 'Volumes', value: dk.volumesBytes || 0, cls: 'seg-volumes' },
        { label: 'Build cache', value: dk.buildCacheBytes || 0, cls: 'seg-cache' },
        { label: 'Free', value: free, cls: 'seg-free' },
      ],
    });
    refs.diskCard.holder.innerHTML = svg;
    refs.diskCard.legend.innerHTML = legend;
  }
}
