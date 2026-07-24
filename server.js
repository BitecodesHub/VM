import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import {
  PANEL_PORT, LOOPBACK, PROTECTED_NAMES, TEMPLATES,
  validateName, validateUsername, firstFreePort, nextName, usedHostPorts,
  mapContainerToCard, buildRunArgs, parseColimaList, listTemplates,
  filterMachinesForUser, quotaUsage, pickLanAddress, USER_RUNNING_LIMIT, isPanelMachine,
  machineAccess, canUse, canDelete, canManageAccess, quotaExceeded, QUOTA_STATES,
} from './lib/core.js';
import { loadConfig } from './lib/config.js';
import { ensureDataDir, ensureSecret } from './lib/store.js';
import { UserStore } from './lib/users.js';
import { SessionStore } from './lib/sessions.js';
import { ShareStore } from './lib/shares.js';
import { MachineMetaStore } from './lib/machineMeta.js';
import { UsageStore } from './lib/usage.js';
import { UsageSessionStore } from './lib/usage-sessions.js';
import { summariseSessions } from './lib/analytics.js';
import { mintSsoToken, verifySsoToken, OneTimeGuard } from './lib/sso.js';
import { MetricsStore, deriveAlerts } from './lib/metrics.js';
import { AuditLog } from './lib/audit.js';
import { sweepStale } from './lib/tmpsweep.js';
import { validatePassword, LoginLimiter, RateLimiter } from './lib/auth.js';
import {
  parseProxyPath, isAllowedHost, isAllowedOrigin, errorPage, proxyHttp, proxyUpgrade,
} from './lib/proxy.js';
import {
  parseDockerStats, parseSystemDf, parsePsSizes, shapeMachineStats, buildResourcesPayload,
} from './lib/stats.js';

// Binaries and data dir are overridable via env so integration tests can point
// at fake docker/colima shims and a temp data dir (see test/helpers/).
const DOCKER = process.env.VMP_DOCKER || '/opt/homebrew/bin/docker';
const COLIMA = process.env.VMP_COLIMA || '/opt/homebrew/bin/colima';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = process.env.VMP_DATA_DIR || path.join(__dirname, 'data');

const TIMEOUTS = { read: 5000, mutate: 60000, colima: 300000, stats: 15000 };

// App version (surfaced in /api/state → footer/System tab). Best-effort read.
let VERSION = '0.0.0';
try { VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || VERSION; } catch { /* keep default */ }

// ---- Boot: config + stores -------------------------------------------------
ensureDataDir(DATA_DIR);
const config = loadConfig(DATA_DIR);

// Tagged, alerted, bounded exit for any fatal condition. launchd
// (SuccessfulExit=false) restarts us; without this a crash-loop (e.g. a corrupt
// users.json) is INVISIBLE. Logs a greppable [VMP_FATAL] line and, if configured,
// POSTs the alert webhook before exiting non-zero (bounded so exit can't hang).
// `sync:true` (boot path) exits IMMEDIATELY so module execution cannot continue
// with half-initialised stores; the webhook is fire-and-forget and may not flush.
// Default (runtime crash-net) defers exit briefly so the webhook reliably POSTs.
function fatalExit(detail, { sync = false } = {}) {
  try { console.error(`[VMP_FATAL] ${new Date().toISOString()} ${detail}`); } catch { /* ignore */ }
  const bye = () => process.exit(1);
  const post = () => {
    if (!config.alertWebhook) return null;
    return fetch(config.alertWebhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `VM Panel FATAL — ${String(detail).slice(0, 300)}` }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {});
  };
  if (sync) { try { post(); } catch { /* ignore */ } bye(); return; }
  if (config.alertWebhook) { try { post().finally(bye); setTimeout(bye, 2000).unref(); } catch { bye(); } }
  else bye();
}

const SECRET = ensureSecret(path.join(DATA_DIR, 'secret'));
// A corrupt/unreadable store throws here — at BOOT, before the runtime crash-net
// is armed. Catch it so the failure is tagged + alerted, not a silent loop.
let users, sessions, shares, usage, metrics, machineMeta;
try {
  users = new UserStore(path.join(DATA_DIR, 'users.json')).load();
  sessions = new SessionStore(path.join(DATA_DIR, 'sessions.json'), SECRET, {
    secure: !!config.publicTls,
    absoluteMaxMs: config.sessionMaxDays * 24 * 60 * 60 * 1000,
    idleMs: config.sessionIdleHours * 60 * 60 * 1000,
  }).load();
  shares = new ShareStore(path.join(DATA_DIR, 'machines.json')).load();
  machineMeta = new MachineMetaStore(path.join(DATA_DIR, 'machine-meta.json')).load();
  usage = new UsageStore(path.join(DATA_DIR, 'usage.json')).load();
  metrics = new MetricsStore(path.join(DATA_DIR, 'metrics.json')).load();
} catch (e) {
  fatalExit(`boot: store load failed — ${e?.message || e}`);
}
// Append-only audit trail (privileged actions). Not in the try block — a bad
// audit file must never block boot; it self-heals on the next trim.
const audit = new AuditLog(path.join(DATA_DIR, 'audit.jsonl'));
// Per-user × per-machine session ledger (who used which machine, for how long).
// Outside the try + load wrapped: a corrupt checkpoint must never block boot —
// worst case we start with no live sessions, which reconcile() treats as ended.
const usageSessions = new UsageSessionStore(
  path.join(DATA_DIR, 'usage-sessions.jsonl'),
  path.join(DATA_DIR, 'usage-open.json'),
);
try { usageSessions.load(); } catch (e) { console.error(`[VMP_USAGE] ignoring corrupt open-session checkpoint — ${e?.message || e}`); }
{
  const orphaned = usageSessions.reconcile('panel_restart');
  if (orphaned) console.error(`[VMP_USAGE] closed ${orphaned} orphaned session(s) left open by the previous process`);
}
// Single-use tracker for SSO login tokens (replay protection within their TTL).
const ssoGuard = new OneTimeGuard();
// Real client IP behind the Caddy loopback front. Caddy appends the true client
// IP to X-Forwarded-For; trust it ONLY when the immediate peer is loopback (the
// reverse proxy), and take the RIGHTMOST hop (the one Caddy appended — a client
// cannot forge entries after it). Direct non-loopback peers are used verbatim so
// the guard is unspoofable. Without this, every request looks like 127.0.0.1,
// which collapses the per-IP login limiter into one global bucket (login DoS)
// and destroys source-IP attribution in the audit log + sessions.
function clientIp(req) {
  const peer = req?.socket?.remoteAddress || '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (loopback) {
    const xff = req?.headers?.['x-forwarded-for'];
    if (xff) {
      const hops = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
  }
  return peer;
}
function recordAudit(req, actor, action, target = null, detail = null) {
  audit.record({ actor, action, target, detail, ip: clientIp(req) || null });
}
const firedAlerts = new Set(); // critical alert ids already notified (dedupe webhook/log)
const loginLimiter = new LoginLimiter();
// Per-user throttle on expensive side-effectful actions (machine create/lifecycle/
// delete, uploads, VM control). 60/min is far above human use but caps a runaway
// or compromised client from flooding the docker CLI or filling the disk.
const actionLimiter = new RateLimiter({ windowMs: 60_000, limit: config.actionRateLimit });
setInterval(() => sessions.sweep(), 10 * 60 * 1000).unref?.();

// Public HTTPS origins served by the Caddy TLS front (additive — direct HTTP on
// 5050/5051 keeps working). The guards accept these so requests proxied through
// Caddy pass CSRF/Origin checks; screens are framed by, and served from, these.
function publicHosts() { return config.publicTls && config.publicHost ? [config.publicHost, 'localhost'] : []; }
// Acceptable HTTPS origins for a given public port. Browsers OMIT the default
// :443 from the Origin header (`https://host`, not `https://host:443`), so when
// the front is on 443 we must accept the port-less form too — otherwise the
// CSRF/Origin guard rejects every POST (login included) on a :443 deployment.
function publicOrigins(port) {
  const out = [];
  for (const h of publicHosts()) {
    out.push(`https://${h}:${port}`);
    if (port === 443) out.push(`https://${h}`);
  }
  return out;
}
function isPanelPublicOrigin(origin) { return publicOrigins(config.panelHttpsPort).includes(origin); }
function isMachinePublicOrigin(origin) { return publicOrigins(config.machineHttpsPort).includes(origin); }

// Does the docker daemon's host expose a v4l2loopback camera we can map into a
// Media Desktop? Explicit config wins; otherwise auto-detect a /dev/video0 the
// daemon can see. On native Linux the daemon IS the host, so fs.existsSync is
// authoritative. On Colima the device lives in the VM (invisible here), so the
// admin sets config.hostWebcam=true after enable-webcam-colima.sh. Probed once
// at boot — camera hardware does not appear/vanish under a running panel.
function probeHostWebcam() {
  if (typeof config.hostWebcam === 'boolean') return config.hostWebcam;
  try { return fs.existsSync('/dev/video0'); } catch { return false; }
}
const hostWebcam = probeHostWebcam();

// Per-machine activity: an open screen socket keeps a machine "active"; the idle
// reaper stops desktops with no open screen for config.idleStopMinutes. Seeded to
// "now" on first sight so a panel restart never mass-reaps.
const machineActivity = new Map(); // name -> { lastActive, open }
function touchMachine(name) { const e = machineActivity.get(name) || { open: 0 }; e.lastActive = Date.now(); machineActivity.set(name, e); }
function openMachineConn(name) { const e = machineActivity.get(name) || { open: 0 }; e.open = (e.open || 0) + 1; e.lastActive = Date.now(); machineActivity.set(name, e); }
function closeMachineConn(name) { const e = machineActivity.get(name); if (e) { e.open = Math.max(0, (e.open || 0) - 1); e.lastActive = Date.now(); } }

// Once-a-minute maintenance: usage accounting (machine-minutes per owner) plus
// idle-desktop reaping. Fires 60s after boot, so all module state is initialised.
async function maintenanceTick() {
  let byName;
  try { ({ byName } = await cardsCached()); } catch { return; }
  const idleMs = config.idleStopMinutes > 0 ? config.idleStopMinutes * 60_000 : 0;
  const now = Date.now();
  for (const card of byName.values()) {
    if (!isPanelMachine(card) || card.state !== 'running') continue;
    usage.add(card.owner, card.template, 1); // 1 machine-minute
    if (!idleMs || !/desktop/.test(card.template)) continue; // reap desktops only
    const a = machineActivity.get(card.name);
    if (!a) { machineActivity.set(card.name, { open: 0, lastActive: now }); continue; } // seed grace window
    if (a.open > 0 || now - a.lastActive < idleMs || inFlight.has(card.name)) continue;
    console.error(`[VMP_IDLE_STOP] ${new Date(now).toISOString()} stopping idle ${card.name} (owner=${card.owner})`);
    inFlight.add(card.name);
    run(DOCKER, ['stop', '-t', '10', card.name], TIMEOUTS.mutate)
      .then(() => { invalidateMachineCache(); dropBrowserSession(card.name); })
      .catch(() => {})
      .finally(() => inFlight.delete(card.name));
  }
  // Sample aggregate metrics + evaluate alerts (best-effort).
  try {
    const r = await getResources({ role: 'admin', username: '__sampler__' });
    metrics.record({
      vmRunning: !!r.vmRunning,
      memUsed: r.used?.memBytes ?? null, memTotal: r.capacity?.memBytes ?? null,
      cpuPct: r.used?.cpuPerc ?? null, cpuCores: r.capacity?.cpu ?? null,
      diskUsed: r.used?.disk?.totalBytes ?? null, diskTotal: r.capacity?.diskBytes ?? null,
      running: (r.machines || []).filter((m) => m.state === 'running').length,
      // Only RUNNING machines can be unhealthy — Docker keeps a stale
      // Health.Status on cleanly-exited containers, which otherwise raised a
      // permanent "unhealthy — a restart may fix it" banner on stopped machines.
      unhealthy: [...byName.values()].filter((c) => isPanelMachine(c) && c.state === 'running' && c.health === 'unhealthy').length,
    });
    evaluateAlerts();
  } catch { /* sampling is best-effort */ }
  // Heartbeat live usage sessions so a crash loses at most one tick of duration.
  usageSessions.heartbeat();
}
setInterval(() => { maintenanceTick().catch(() => {}); }, 60_000).unref?.();

// Age of the last successful backup (backup.sh writes data/last-backup on success),
// or null if a backup was never taken — so an unconfigured box never nags.
function backupAgeMs() {
  try { return Date.now() - fs.statSync(path.join(DATA_DIR, 'last-backup')).mtimeMs; }
  catch { return null; }
}
// Single source of truth for alerts (adds backup-staleness to the metrics-derived set).
function currentAlerts() {
  return deriveAlerts(metrics.latest(), { backupAgeMs: backupAgeMs() });
}

// Fire a webhook/log once when a critical alert first appears; clear when resolved.
function evaluateAlerts() {
  const alerts = currentAlerts();
  const critNow = new Set(alerts.filter((a) => a.level === 'critical').map((a) => a.id));
  for (const a of alerts) {
    if (a.level === 'critical' && !firedAlerts.has(a.id)) { firedAlerts.add(a.id); notifyCritical(a); }
  }
  for (const id of [...firedAlerts]) if (!critNow.has(id)) firedAlerts.delete(id);
}
function notifyCritical(a) {
  console.error(`[VMP_ALERT] ${new Date().toISOString()} CRITICAL ${a.id}: ${a.title}`);
  try { fs.appendFileSync(path.join(DATA_DIR, 'alerts.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...a }) + '\n', { mode: 0o600 }); } catch { /* ignore */ }
  if (config.alertWebhook) {
    fetch(config.alertWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `VM Panel alert: ${a.title}` }), signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

// Hostnames (besides IP literals / localhost) the host guard accepts.
const EXTRA_HOSTS = config.lanHost ? [String(config.lanHost).toLowerCase()] : [];
// P0-2: machine screens are served on a SECOND port (separate origin) so
// container-controlled content cannot ride the panel's origin to hit /api.
// 0 (ephemeral, tests) stays 0 and is resolved to the real port on listen.
let machinePort = config.port === 0 ? 0 : config.port + 1;

// Sharing set for a user (null for admins, who see everything).
const sharedSetFor = (user) => (user.role === 'admin' ? null : shares.sharedWithUser(user.username));
// One authorization choke point.
const accessFor = (user, card) => machineAccess(user, card, sharedSetFor(user));

// ---- In-memory state -------------------------------------------------------
let vmTransition = null;
// Outcome of the most recent colima start/stop, so a failed/timed-out transition
// is not silently indistinguishable from a clean stop. { kind, ok, timedOut, at, message }.
let lastVmResult = null;
const inFlight = new Set();
const reservedPorts = new Set();
let lastMachines = [];
const upgradedSockets = new Set();
const pendingQuota = new Map();   // username -> Set(token)
let quotaToken = 0;

function pendingCount(u) { return pendingQuota.get(u)?.size || 0; }
function totalPending() { let n = 0; for (const s of pendingQuota.values()) n += s.size; return n; }
// System-wide count of machines that consume capacity right now (running/restarting/
// paused) plus in-flight create/start reservations. Used for the global ceiling.
function runningPlusPending(cards) {
  return cards.filter((c) => isPanelMachine(c) && QUOTA_STATES.has(c.state)).length + totalPending();
}
function reserveQuota(u, token) {
  let s = pendingQuota.get(u);
  if (!s) { s = new Set(); pendingQuota.set(u, s); }
  s.add(token);
}
function releaseQuota(u, token) {
  const s = pendingQuota.get(u);
  if (s) { s.delete(token); if (!s.size) pendingQuota.delete(u); }
}

// ---- CLI helper ------------------------------------------------------------
function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', code: err?.code });
    });
  });
}
function isDockerDown(stderr) {
  return /Cannot connect to the Docker daemon|dial unix|connection refused|context deadline exceeded|is the docker daemon running/i.test(stderr || '');
}
class DockerDownError extends Error {}
function tail(s, n = 2048) { s = s || ''; return s.length > n ? s.slice(-n) : s; }

async function inspectAll() {
  const ids = await run(DOCKER, ['ps', '-aq'], TIMEOUTS.read);
  if (!ids.ok) {
    if (isDockerDown(ids.stderr)) throw new DockerDownError();
    throw new Error(ids.stderr || 'docker ps failed');
  }
  const idList = ids.stdout.trim().split('\n').filter(Boolean);
  if (!idList.length) return [];
  const insp = await run(DOCKER, ['inspect', ...idList], TIMEOUTS.read);
  if (!insp.ok) {
    if (isDockerDown(insp.stderr)) throw new DockerDownError();
    throw new Error(insp.stderr || 'docker inspect failed');
  }
  try { return JSON.parse(insp.stdout); } catch { return []; }
}
async function inspectCards() {
  return (await inspectAll()).map(mapContainerToCard);
}

// ---- Generic single-flight TTL cache ---------------------------------------
function ttlCache(ttl, fetcher) {
  let at = 0, value = null, promise = null;
  return {
    async get() {
      if (value !== null && Date.now() - at < ttl) return { value, stale: false, at };
      if (!promise) {
        promise = fetcher()
          .then((v) => { value = v; at = Date.now(); return v; })
          .catch(() => null)
          .finally(() => { promise = null; });
      }
      const fresh = await promise;
      return { value, stale: fresh === null, at };
    },
    invalidate() { at = 0; },
  };
}

// ---- Machine cache (proxy + ownership resolution) --------------------------
// { ok, byName } — ok=false when docker is unreachable. 5s TTL, single-flight.
const cardsCacheImpl = ttlCache(5000, async () => {
  const cards = await inspectCards();
  return { ok: true, byName: new Map(cards.map((c) => [c.name, c])) };
});
async function cardsCached() {
  const { value } = await cardsCacheImpl.get();
  return value || { ok: false, byName: new Map() };
}
async function resolveMachineCached(name) {
  const { byName } = await cardsCached();
  return byName.get(name) || null;
}
// Called after any lifecycle mutation so stats/sharing views do not lag 5s.
function invalidateMachineCache() { cardsCacheImpl.invalidate(); }

// ---- Stats / disk / VM caches (Resources feature) --------------------------
// stats TTL is the freshness floor for the Resources tab's live updates; 5s keeps
// it feeling real-time while capping `docker stats` at ~12/min AND only while a
// client is actually viewing Resources (nothing polls /api/resources otherwise).
const statsCache = ttlCache(5_000, async () => {
  const r = await run(DOCKER, ['stats', '--no-stream', '--format', '{{json .}}'], TIMEOUTS.stats);
  if (!r.ok) throw new Error('stats failed');
  return { data: parseDockerStats(r.stdout), at: new Date().toISOString() };
});
const diskCache = ttlCache(60_000, async () => {
  const [df, sizes] = await Promise.all([
    run(DOCKER, ['system', 'df', '--format', '{{json .}}'], TIMEOUTS.read),
    run(DOCKER, ['ps', '-a', '--size', '--format', '{{json .}}'], TIMEOUTS.read),
  ]);
  if (!df.ok || !sizes.ok) throw new Error('disk failed');
  return { df: parseSystemDf(df.stdout), sizes: parsePsSizes(sizes.stdout), at: new Date().toISOString() };
});
const vmCache = ttlCache(10_000, async () => {
  const r = await run(COLIMA, ['list', '--json'], TIMEOUTS.read);
  if (!r.ok) throw new Error('colima failed');
  return parseColimaList(r.stdout);
});

// ---- Port allocation -------------------------------------------------------
function probePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, LOOPBACK);
  });
}
async function allocatePorts(template, usedBase) {
  const t = TEMPLATES[template];
  const used = new Set([...usedBase, ...reservedPorts]);
  const result = {};
  try {
    for (const spec of t.ports) {
      let port = null;
      let cursor = spec.range[0];
      while (true) {
        const candidate = firstFreePort([cursor, spec.range[1]], used);
        if (candidate == null) throw new Error('PORT_ALLOC_FAILED');
        if (await probePort(candidate)) { port = candidate; break; }
        used.add(candidate);
        cursor = candidate + 1;
      }
      result[spec.role] = port;
      used.add(port);
      reservedPorts.add(port);
    }
    return result;
  } catch (e) {
    releasePorts(result); // release any partial reservations before propagating
    throw e;
  }
}
function releasePorts(ports) { for (const p of Object.values(ports || {})) reservedPorts.delete(p); }

// ---- State -----------------------------------------------------------------
async function getState(user) {
  const vm = (await vmCache.get()).value || { running: false, status: 'unknown', cpu: null, memoryGiB: null, diskGiB: null, arch: null };
  vm.transition = vmTransition?.kind || null;
  vm.elapsedMs = vmTransition ? Date.now() - vmTransition.startedAt : 0;
  // Surface only a FAILED last transition (so it is not read as a clean stop).
  // The colima stderr message is admin-only.
  if (lastVmResult && !lastVmResult.ok && !vmTransition) {
    vm.lastResult = user.role === 'admin'
      ? lastVmResult
      : { kind: lastVmResult.kind, ok: false, timedOut: lastVmResult.timedOut, at: lastVmResult.at };
  }
  const panel = { port: config.port, machinePort, lanHost: config.lanHost || pickLanAddress(os.networkInterfaces()), tls: config.publicTls, publicHost: config.publicHost, panelHttpsPort: config.panelHttpsPort, machineHttpsPort: config.machineHttpsPort, hostWebcam, secureContext: !!config.publicTls, version: VERSION };
  const sharedNames = sharedSetFor(user);

  const wrap = (cards, stale, dockerReachable) => {
    // A non-running node cannot hold a live browser window — evict its session
    // immediately (fresh data only) so cards never advertise a dead browser.
    if (!stale) for (const c of cards) if (c.state !== 'running' && browserSessions.has(c.name)) dropBrowserSession(c.name);
    const machines = filterMachinesForUser(cards, user, sharedNames).map((c) => {
      const access = machineAccess(user, c, sharedNames);
      const decorated = { ...c, access };
      const dn = machineMeta.displayName(c.name);
      if (dn) decorated.displayName = dn;
      if (user.role === 'admin') decorated.sharedWith = shares.listFor(c.name);
      if (browserSessions.has(c.name)) decorated.browserActive = true;
      return decorated;
    });
    const quota = user.role === 'admin' ? null : quotaUsage(cards, user.username);
    // Alerts are derived from the latest metrics sample (cheap, no docker call).
    const alerts = currentAlerts();
    return { schemaVersion: 3, vm, dockerReachable, stale, machines, user, quota, panel, alerts };
  };

  if (vmTransition || !vm.running) return wrap(lastMachines, true, false);
  try {
    // Serve from the 5s single-flight cache instead of a fresh docker pass per
    // request — the SPA polls every 4s, so ~30-40 clients would otherwise fan out
    // into a docker-inspect storm on the event loop. Lifecycle mutations call
    // invalidateMachineCache() so user actions still reflect immediately.
    const { ok, byName } = await cardsCached();
    if (!ok) return wrap(lastMachines, true, false);
    const cards = [...byName.values()].filter(isPanelMachine); // panel machines only
    lastMachines = cards;
    // Prune shares whose machine no longer exists — ONLY on the trustworthy
    // fresh path (never from stale/empty state).
    const liveNames = new Set(cards.map((c) => c.name));
    shares.sweep(liveNames).catch(() => {});
    machineMeta.sweep(liveNames).catch(() => {});
    return wrap(cards, false, true);
  } catch (e) {
    if (e instanceof DockerDownError) return wrap(lastMachines, true, false);
    throw e;
  }
}

// ---- Machine resolution + capability ---------------------------------------
// need: 'use' | 'delete'. Returns { card, cards, access } or { error }.
// Invisible/non-panel machines → 404 (no existence oracle). Visible but
// insufficient (shared user deleting) → 403.
async function resolveMachine(user, name, need = 'use') {
  if (!validateName(name)) return { error: { status: 400, body: { error: { code: 'VALIDATION', message: 'invalid name' } } } };
  let cards;
  try { cards = await inspectCards(); }
  catch (e) {
    if (e instanceof DockerDownError) return { error: { status: 503, body: { error: { code: 'DOCKER_UNAVAILABLE', message: 'Docker daemon unreachable' } } } };
    throw e;
  }
  const card = cards.find((c) => c.name === name);
  // Only panel-created machines are ever addressable (protects careledger etc.).
  if (!card || !isPanelMachine(card)) return { error: { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such machine' } } } };
  const access = accessFor(user, card);
  if (!canUse(access)) return { error: { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such machine' } } } };
  if (need === 'delete' && !canDelete(access)) {
    return { error: { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Only the owner or an admin can delete this machine.' } } } };
  }
  return { card, cards, access };
}

// ---- Create ----------------------------------------------------------------
// opts (admin-only, ignored for regular users): { name, viewers }.
async function createMachine(user, template, opts = {}) {
  const t = TEMPLATES[template];
  if (!t) return { status: 400, body: { error: { code: 'VALIDATION', message: 'unknown template' } } };
  if (vmTransition) return { status: 503, body: { error: { code: 'COLIMA_TRANSITION', message: 'VM is transitioning' } } };

  const isAdmin = user.role === 'admin';
  // Custom name + viewer assignment are admin-only; regular users always get the
  // quick auto-named create (owned by them) with no sharing.
  const customName = isAdmin && opts.name != null && String(opts.name).trim() !== '' ? String(opts.name).trim() : null;
  let viewers = isAdmin && Array.isArray(opts.viewers) ? [...new Set(opts.viewers)].filter((v) => v !== user.username) : [];
  if (customName !== null) {
    if (!validateName(customName)) return { status: 400, body: { error: { code: 'VALIDATION', message: 'invalid name (letters, digits, _ . - only)' } } };
    if (PROTECTED_NAMES.has(customName)) return { status: 400, body: { error: { code: 'VALIDATION', message: 'that name is reserved' } } };
  }
  if (viewers.length > 256) return { status: 400, body: { error: { code: 'VALIDATION', message: 'too many viewers' } } };
  for (const v of viewers) {
    if (!validateUsername(v) || !users.get(v)) return { status: 400, body: { error: { code: 'VALIDATION', message: `unknown user: ${v}` } } };
  }
  // Resources are shared by default; admins may opt this machine into hard caps
  // (per-create wins over the global config.capResources default).
  const cap = isAdmin && typeof opts.cap === 'boolean' ? opts.cap : !!config.capResources;

  let inspects;
  try { inspects = await inspectAll(); }
  catch (e) {
    if (e instanceof DockerDownError) return { status: 503, body: { error: { code: 'DOCKER_UNAVAILABLE', message: 'Docker daemon unreachable' } } };
    throw e;
  }
  const cards = inspects.map(mapContainerToCard);
  const names = inspects.map((i) => String(i.Name).replace(/^\//, ''));
  const usedBase = usedHostPorts(inspects);
  const username = user.username;
  if (customName !== null && names.includes(customName)) {
    return { status: 409, body: { error: { code: 'NAME_TAKEN', message: `The name “${customName}” is already in use.` } } };
  }

  // Global capacity ceiling (system-wide, all owners — admins included). Protects
  // the host from oversubscription when resources are shared by default.
  if (config.maxRunningMachines > 0 && runningPlusPending(cards) >= config.maxRunningMachines) {
    return { status: 503, body: { error: { code: 'AT_CAPACITY', message: `The system is at capacity (${config.maxRunningMachines} machines running). Ask a colleague to stop one, or try again shortly.` } } };
  }

  // Synchronous quota check + reserve (atomic on the single-threaded loop).
  let token = null;
  if (!isAdmin) {
    if (quotaExceeded(cards, username, pendingCount(username))) {
      const used = quotaUsage(cards, username).used + pendingCount(username);
      return { status: 403, body: { error: { code: 'QUOTA_EXCEEDED', message: `Machine limit reached (${used} of ${USER_RUNNING_LIMIT}).` }, quota: { used, limit: USER_RUNNING_LIMIT } } };
    }
    token = `create-${username}-${quotaToken++}`;
    reserveQuota(username, token);
  }

  const webdriverBind = config.exposeWebdriver === 'lan' ? '0.0.0.0' : LOOPBACK;
  // Webcam is host-gated and can go stale: config.hostWebcam may say true while
  // the device was destroyed (e.g. a Colima VM rebuild). Rather than fail every
  // Media Desktop create with an opaque 500, degrade to audio-only if docker
  // reports the device is missing. `webcam` drops to false on that specific error.
  let webcam = hostWebcam;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const name = customName || nextName(t.namePrefix, names);
      let ports;
      try { ports = await allocatePorts(template, usedBase); }
      catch { return { status: 503, body: { error: { code: 'PORT_ALLOC_FAILED', message: 'no free port in range' } } }; }
      try {
        const args = buildRunArgs({ template, name, ports, createdAt: new Date().toISOString(), owner: username, webdriverBind, cap, hostWebcam: webcam });
        const r = await run(DOCKER, args, TIMEOUTS.mutate);
        if (r.ok) {
          invalidateMachineCache();
          if (viewers.length) { try { await shares.setList(name, viewers); } catch { /* machine created; sharing is best-effort */ } }
          const uiUrl = `/m/${name}${t.ui.path}` + (t.ui.path.includes('?') ? '&' : '?') + `path=${encodeURIComponent(`m/${name}/websockify`)}` + (t.ui.password.mode === 'query' ? `&password=${encodeURIComponent(t.ui.password.value)}` : '');
          return { status: 202, body: { ok: true, name, uiUrl, sharedWith: viewers } };
        }
        // A fixed custom name cannot be auto-incremented away — surface the clash.
        if (/name .*already in use|Conflict|is already in use by container/i.test(r.stderr)) {
          if (customName) return { status: 409, body: { error: { code: 'NAME_TAKEN', message: `The name “${name}” is already in use.` } } };
          names.push(name);
          continue;
        }
        if (/already allocated|address already in use|port is already allocated/i.test(r.stderr)) {
          for (const p of Object.values(ports)) usedBase.add(p); // retry ports, keep the name
          continue;
        }
        // Stale/absent webcam device: retry once WITHOUT the camera so the
        // desktop still comes up (audio + mic work regardless). Only meaningful
        // for a media template that asked for the device.
        if (webcam && /error gathering device information|no such (file or directory|device)|\/dev\/video0/i.test(r.stderr)) {
          console.error(`[VMP] ${name}: host webcam device unavailable — creating without camera (audio/mic unaffected)`);
          webcam = false;
          continue; // keep the name + ports; rebuild args without --device
        }
        // Raw docker stderr can carry host paths/image internals — admins only.
        return { status: 500, body: { error: { code: 'DOCKER_CLI_ERROR', message: 'The machine could not be created. Please try again or contact an administrator.', ...(isAdmin ? { stderr: tail(r.stderr) } : {}) } } };
      } finally {
        releasePorts(ports);
      }
    }
    return { status: 500, body: { error: { code: 'DOCKER_CLI_ERROR', message: 'create failed after retries' } } };
  } finally {
    if (token) releaseQuota(username, token);
  }
}

// ---- Lifecycle -------------------------------------------------------------
async function lifecycle(user, name, action) {
  if (vmTransition) return { status: 503, body: { error: { code: 'COLIMA_TRANSITION', message: 'VM is transitioning' } } };
  const resolved = await resolveMachine(user, name, 'use');
  if (resolved.error) return resolved.error;
  const { card, cards } = resolved;
  if (inFlight.has(name)) return { status: 409, body: { error: { code: 'JOB_IN_FLIGHT', message: 'another action is in progress' } } };

  const argsByAction = {
    start: ['start', name],
    stop: ['stop', '-t', '10', name],
    restart: ['restart', '-t', '10', name],
    unpause: ['unpause', name],
  };
  const args = argsByAction[action];
  if (!args) return { status: 400, body: { error: { code: 'VALIDATION', message: 'unknown action' } } };

  // Starting counts against the system-wide ceiling too (admins included).
  if (action === 'start' && config.maxRunningMachines > 0 && runningPlusPending(cards) >= config.maxRunningMachines) {
    return { status: 503, body: { error: { code: 'AT_CAPACITY', message: `The system is at capacity (${config.maxRunningMachines} machines running). Stop one first, or try again shortly.` } } };
  }

  // Starting a stopped machine consumes a quota slot charged to the OWNER (not
  // the actor), so a shared user cannot exceed the owner's budget. Admin actors
  // stay exempt.
  let token = null;
  const chargeTo = card.owner;
  if (action === 'start' && user.role !== 'admin' && chargeTo) {
    if (quotaExceeded(cards, chargeTo, pendingCount(chargeTo))) {
      const used = quotaUsage(cards, chargeTo).used + pendingCount(chargeTo);
      return { status: 403, body: { error: { code: 'QUOTA_EXCEEDED', message: `Machine limit reached (${used} of ${USER_RUNNING_LIMIT}).` }, quota: { used, limit: USER_RUNNING_LIMIT } } };
    }
    token = `start-${chargeTo}-${quotaToken++}`;
    reserveQuota(chargeTo, token);
  }

  inFlight.add(name);
  try {
    const r = await run(DOCKER, args, TIMEOUTS.mutate);
    invalidateMachineCache();
    if (action === 'stop' || action === 'restart') dropBrowserSession(name); // Selenium died with the container
    if (r.ok) return { status: 200, body: { ok: true } };
    return { status: 500, body: { error: { code: 'DOCKER_CLI_ERROR', message: `Could not ${action} the machine. Please try again.`, ...(user.role === 'admin' ? { stderr: tail(r.stderr) } : {}) } } };
  } finally {
    inFlight.delete(name);
    if (token) releaseQuota(chargeTo, token);
  }
}

// Internal delete (no ownership/confirm — callers must have authorized).
async function rmContainer(name) {
  await run(DOCKER, ['stop', '-t', '10', name], TIMEOUTS.mutate);
  let r = await run(DOCKER, ['rm', name], TIMEOUTS.mutate);
  if (!r.ok) r = await run(DOCKER, ['rm', '-f', name], TIMEOUTS.mutate);
  return r.ok;
}

async function deleteMachine(user, name, confirm) {
  if (PROTECTED_NAMES.has(name)) return { status: 403, body: { error: { code: 'PROTECTED', message: 'this machine is protected' } } };
  if (confirm !== name) return { status: 400, body: { error: { code: 'VALIDATION', message: 'confirmation mismatch' } } };
  if (vmTransition) return { status: 503, body: { error: { code: 'COLIMA_TRANSITION', message: 'VM is transitioning' } } };
  const resolved = await resolveMachine(user, name, 'delete');
  if (resolved.error) return resolved.error;
  if (inFlight.has(name)) return { status: 409, body: { error: { code: 'JOB_IN_FLIGHT', message: 'another action is in progress' } } };

  inFlight.add(name);
  try {
    const ok = await rmContainer(name);
    invalidateMachineCache();
    dropBrowserSession(name);
    if (!ok) return { status: 500, body: { error: { code: 'DOCKER_CLI_ERROR', message: 'delete failed' } } };
    await shares.removeMachine(name); // drop its access list
    await machineMeta.removeMachine(name); // drop its display name
    return { status: 200, body: { ok: true } };
  } finally {
    inFlight.delete(name);
  }
}

// ---- Logs / readiness ------------------------------------------------------
async function getLogs(user, name, tailN) {
  const resolved = await resolveMachine(user, name, 'use');
  if (resolved.error) return { status: resolved.error.status, text: resolved.error.body.error.message };
  const allowed = new Set([100, 500, 2000]);
  const n = allowed.has(tailN) ? tailN : 500;
  const r = await run(DOCKER, ['logs', '--tail', String(n), '--timestamps', name], TIMEOUTS.read);
  return { status: 200, text: (r.stdout || '') + (r.stderr || '') };
}

// `tls` must match the backend: KasmVNC desktops serve HTTPS (and answer 401
// until Basic auth, which still means "up"), so a plain-HTTP probe against them
// always fails and leaves the card stuck on "Booting…". Any status < 500 = up.
function httpProbe(port, tls = false) {
  return new Promise((resolve) => {
    const mod = tls ? https : http;
    const opts = { host: LOOPBACK, port, path: '/', timeout: 2000, ...(tls ? { rejectUnauthorized: false, servername: 'localhost' } : {}) };
    const req = mod.get(opts, (res) => {
      res.resume();
      resolve(res.statusCode > 0 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function readiness(user, name) {
  const resolved = await resolveMachine(user, name, 'use');
  if (resolved.error) return resolved.error;
  const { card } = resolved;
  if (card.state !== 'running' || !card.uiPort) return { status: 200, body: { ready: false, checkedAt: new Date().toISOString() } };
  const ready = await httpProbe(card.uiPort, backendProxyOpts(card).backendTls);
  return { status: 200, body: { ready, url: card.uiUrl, checkedAt: new Date().toISOString() } };
}

// ---- File transfer (docker cp) ---------------------------------------------
// Upload/download files between the user's browser and a machine's upload dir.
// Filenames are basename-only + charset-restricted; size-capped; docker exec/cp
// run via execFile arrays (no shell), so spaces are safe and traversal blocked.
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const UPLOAD_LIMIT = 200 * 1024 * 1024; // 200 MB
let tmpCounter = 0;
function uploadDirFor(card) { return TEMPLATES[card.template]?.uploadDir || '/tmp'; }
function containerUserFor(card) { const m = uploadDirFor(card).match(/^\/home\/([^/]+)/); return m ? m[1] : null; }
function safeFilename(n) { return typeof n === 'string' && FILE_NAME_RE.test(n) && !n.includes('..'); }
function tmpPath(tag) { return path.join(os.tmpdir(), `vmp-${tag}-${Date.now()}-${process.pid}-${tmpCounter++}`); }

async function listMachineFiles(user, name) {
  const resolved = await resolveMachine(user, name, 'use');
  if (resolved.error) return resolved.error;
  const { card } = resolved;
  const dir = uploadDirFor(card);
  if (card.state !== 'running') return { status: 200, body: { dir, files: [] } };
  const r = await run(DOCKER, ['exec', name, 'sh', '-c', `mkdir -p ${JSON.stringify(dir)} 2>/dev/null; ls -lApL --time-style=long-iso ${JSON.stringify(dir)} 2>/dev/null`], TIMEOUTS.read);
  const files = [];
  for (const line of (r.stdout || '').split('\n')) {
    const m = line.match(/^-[rwxsStT-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\S+ \S+)\s+(.+)$/);
    if (m && !m[3].endsWith('/')) files.push({ name: m[3], size: Number(m[1]), mtime: m[2] });
  }
  return { status: 200, body: { dir, files } };
}

function uploadMachineFile(user, name, filename, req, res) {
  if (!safeFilename(filename)) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid filename' } });
  resolveMachine(user, name, 'use').then((resolved) => {
    if (resolved.error) return sendJson(res, resolved.error.status, resolved.error.body);
    const { card } = resolved;
    if (card.state !== 'running') return sendJson(res, 409, { error: { code: 'NOT_RUNNING', message: 'Start the machine first.' } });
    const dir = uploadDirFor(card);
    const tmp = tmpPath('up');
    const ws = fs.createWriteStream(tmp, { mode: 0o600 });
    let size = 0, aborted = false;
    const cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } };
    req.on('data', (c) => {
      size += c.length;
      if (size > UPLOAD_LIMIT && !aborted) { aborted = true; req.destroy(); ws.destroy(); cleanup(); if (!res.headersSent) sendJson(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'file too large (max 200 MB)' } }); }
    });
    req.on('error', cleanup);
    ws.on('error', () => { cleanup(); if (!res.headersSent) sendJson(res, 500, { error: { code: 'IO', message: 'write failed' } }); });
    ws.on('finish', async () => {
      if (aborted) return;
      try {
        await run(DOCKER, ['exec', name, 'mkdir', '-p', dir], TIMEOUTS.mutate);
        const cp = await run(DOCKER, ['cp', tmp, `${name}:${dir}/${filename}`], 180_000);
        if (!cp.ok) { cleanup(); return sendJson(res, 500, { error: { code: 'DOCKER_CLI_ERROR', message: 'copy into machine failed' } }); }
        const cu = containerUserFor(card);
        if (cu) await run(DOCKER, ['exec', name, 'chown', `${cu}:${cu}`, `${dir}/${filename}`], TIMEOUTS.read).catch(() => {});
        cleanup(); touchMachine(name);
        sendJson(res, 200, { ok: true, name: filename });
      } catch { cleanup(); if (!res.headersSent) sendJson(res, 500, { error: { code: 'IO', message: 'upload failed' } }); }
    });
    req.pipe(ws);
  }).catch(() => { if (!res.headersSent) sendJson(res, 500, { error: { code: 'IO', message: 'upload failed' } }); });
}

async function downloadMachineFile(user, name, filename, res) {
  if (!safeFilename(filename)) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid filename' } });
  const resolved = await resolveMachine(user, name, 'use');
  if (resolved.error) return sendJson(res, resolved.error.status, resolved.error.body);
  const dir = uploadDirFor(resolved.card);
  const tmp = tmpPath('dn');
  const cp = await run(DOCKER, ['cp', `${name}:${dir}/${filename}`, tmp], 180_000);
  let stat = null; try { stat = fs.statSync(tmp); } catch { /* missing */ }
  if (!cp.ok || !stat || !stat.isFile()) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such file' } }); }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${filename.replace(/["\\]/g, '')}"`, 'Cache-Control': 'no-store', ...SEC_HEADERS });
  const rs = fs.createReadStream(tmp);
  rs.pipe(res);
  const done = () => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } };
  rs.on('close', done); rs.on('error', () => { done(); res.destroy(); });
}

async function deleteMachineFile(user, name, filename) {
  if (!safeFilename(filename)) return { status: 400, body: { error: { code: 'VALIDATION', message: 'invalid filename' } } };
  const resolved = await resolveMachine(user, name, 'use');
  if (resolved.error) return resolved.error;
  const dir = uploadDirFor(resolved.card);
  await run(DOCKER, ['exec', name, 'rm', '-f', `${dir}/${filename}`], TIMEOUTS.read);
  return { status: 200, body: { ok: true } };
}

// ---- Live browser sessions (Selenium nodes) ---------------------------------
// "Open browser" starts a real WebDriver session so the node's screen shows an
// actual browser window instead of an empty desktop. Selenium standalone reaps
// idle sessions after ~300s, so each open session gets a keep-alive ping every
// 45s (a session command resets the idle timer; the short interval also detects
// a died browser fast, so cards do not advertise a stale "browser running" —
// the Grid-splash-instead-of-Chrome bug). The session ids are PERSISTED
// (data/browser-sessions.json) and re-attached on boot, so a panel restart no
// longer orphans a live browser window.
const browserSessions = new Map(); // name -> { sessionId, wdPort, timer, startedAt }
const WD_START_PAGE = 'https://www.google.com';
const BROWSER_SESSIONS_FILE = path.join(DATA_DIR, 'browser-sessions.json');

async function wdFetch(port, method, p, body, timeoutMs = 30_000) {
  const res = await fetch(`http://${LOOPBACK}:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// Keep-alive pinger: resets Selenium's idle timer; drops the session on failure.
function keepAliveTimer(name, wdPort, sessionId) {
  const timer = setInterval(async () => {
    try { const p = await wdFetch(wdPort, 'GET', `/session/${sessionId}/url`, undefined, 10_000); if (p.status !== 200) dropBrowserSession(name); }
    catch { dropBrowserSession(name); }
  }, 45_000);
  timer.unref?.();
  return timer;
}

let _bsFlush = null;
function persistBrowserSessions() {
  if (_bsFlush) return;
  _bsFlush = setTimeout(() => {
    _bsFlush = null;
    const sessions = {};
    for (const [n, e] of browserSessions) sessions[n] = { sessionId: e.sessionId, wdPort: e.wdPort, startedAt: e.startedAt };
    fs.writeFile(BROWSER_SESSIONS_FILE, JSON.stringify({ version: 1, sessions }), { mode: 0o600 }, () => {});
  }, 2000);
  _bsFlush.unref?.();
}

// On boot, re-attach any persisted session whose WebDriver still has it alive.
async function reattachBrowserSessions() {
  let data; try { data = JSON.parse(fs.readFileSync(BROWSER_SESSIONS_FILE, 'utf8')); } catch { return; }
  for (const [name, e] of Object.entries(data?.sessions || {})) {
    if (!e?.sessionId || !e?.wdPort) continue;
    try {
      const ping = await wdFetch(e.wdPort, 'GET', `/session/${e.sessionId}/url`, undefined, 5000);
      if (ping.status !== 200) continue; // dead — drop silently
      browserSessions.set(name, { sessionId: e.sessionId, wdPort: e.wdPort, startedAt: e.startedAt || new Date().toISOString(), timer: keepAliveTimer(name, e.wdPort, e.sessionId) });
    } catch { /* WebDriver unreachable — skip */ }
  }
  persistBrowserSessions(); // rewrite with only the sessions that survived
}

function dropBrowserSession(name) {
  const e = browserSessions.get(name);
  if (!e) return;
  clearInterval(e.timer);
  browserSessions.delete(name);
  persistBrowserSessions();
}

async function openBrowserSession(user, name) {
  const resolved = await resolveMachine(user, name, 'use');
  if (resolved.error) return resolved.error;
  const { card } = resolved;
  const t = TEMPLATES[card.template];
  if (!card.webdriver || !t?.wdBrowserName) return { status: 400, body: { error: { code: 'VALIDATION', message: 'this machine is not a browser node' } } };
  if (card.state !== 'running') return { status: 409, body: { error: { code: 'NOT_RUNNING', message: 'Start the machine first.' } } };

  // Idempotent: if we already hold a live session, reuse it.
  const existing = browserSessions.get(name);
  if (existing) {
    try {
      const r = await wdFetch(existing.wdPort, 'GET', `/session/${existing.sessionId}/url`, undefined, 5000);
      if (r.status === 200) {
        // Re-assert the full-screen rect on every reopen: per W3C, Set Window
        // Rect first RESTORES the window, so a browser minimized by a script
        // un-minimizes instead of leaving the viewer on the bare desktop.
        await wdFetch(existing.wdPort, 'POST', `/session/${existing.sessionId}/window/rect`, { x: 0, y: 0, width: 1920, height: 1080 }, 10_000).catch(() => {});
        return { status: 200, body: { ok: true, sessionId: existing.sessionId, reused: true } };
      }
    } catch { /* fall through and recreate */ }
    dropBrowserSession(name);
  }

  try {
    const created = await wdFetch(card.webdriver.port, 'POST', '/session', {
      capabilities: { alwaysMatch: { browserName: t.wdBrowserName } },
    });
    const sessionId = created.json?.value?.sessionId;
    if (created.status !== 200 || !sessionId) {
      const msg = created.json?.value?.message || `WebDriver answered ${created.status}`;
      return { status: 502, body: { error: { code: 'WEBDRIVER_ERROR', message: String(msg).slice(0, 200) } } };
    }
    // Fill the node's 1920x1080 screen — the browser opens small by default.
    // W3C window/rect works for both Chrome and Firefox (unlike --start-maximized).
    await wdFetch(card.webdriver.port, 'POST', `/session/${sessionId}/window/rect`, { x: 0, y: 0, width: 1920, height: 1080 }, 10_000).catch(() => {});
    // Show something useful immediately (best effort — the window exists regardless).
    await wdFetch(card.webdriver.port, 'POST', `/session/${sessionId}/url`, { url: WD_START_PAGE }, 20_000).catch(() => {});

    browserSessions.set(name, { sessionId, wdPort: card.webdriver.port, timer: keepAliveTimer(name, card.webdriver.port, sessionId), startedAt: new Date().toISOString() });
    persistBrowserSessions();
    return { status: 200, body: { ok: true, sessionId } };
  } catch (e) {
    return { status: 502, body: { error: { code: 'WEBDRIVER_UNREACHABLE', message: 'The browser engine did not answer. The node may still be starting.' } } };
  }
}

async function closeBrowserSession(user, name) {
  const resolved = await resolveMachine(user, name, 'use');
  if (resolved.error) return resolved.error;
  const e = browserSessions.get(name);
  if (e) {
    dropBrowserSession(name);
    await wdFetch(e.wdPort, 'DELETE', `/session/${e.sessionId}`, undefined, 10_000).catch(() => {});
  }
  return { status: 200, body: { ok: true } };
}

// ---- Stats / Resources -----------------------------------------------------
async function getMachineStats(user, name) {
  if (!validateName(name)) return { status: 400, body: { error: { code: 'VALIDATION', message: 'invalid name' } } };
  if (vmTransition) return { status: 503, body: { error: { code: 'COLIMA_TRANSITION', message: 'VM is transitioning' } } };
  const { ok, byName } = await cardsCached();
  if (!ok) return { status: 503, body: { error: { code: 'DOCKER_UNAVAILABLE', message: 'Docker daemon unreachable' } } };
  const card = byName.get(name);
  if (!card || !isPanelMachine(card) || !canUse(accessFor(user, card))) {
    return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such machine' } } };
  }
  const [s, d] = await Promise.all([statsCache.get(), diskCache.get()]);
  const body = shapeMachineStats({
    card,
    statsEntry: s.value?.data?.byName?.get(name) || null,
    sizeEntry: d.value?.sizes?.get(name) || null,
    sampledAt: s.value?.at || null,
    diskSampledAt: d.value?.at || null,
    stale: s.stale,
  });
  return { status: 200, body };
}

async function getResources(user) {
  const vm = (await vmCache.get()).value || { running: false, cpu: null, memoryBytes: null, diskBytes: null };
  if (vmTransition || !vm.running) {
    return buildResourcesPayload({ user, cards: lastMachines, stats: null, df: null, sizes: null, vm, dockerReachable: false });
  }
  const { ok, byName } = await cardsCached();
  const cards = ok ? [...byName.values()] : lastMachines;
  const [s, d] = await Promise.all([statsCache.get(), diskCache.get()]);
  return buildResourcesPayload({
    user, cards,
    stats: s.value?.data || null,
    df: d.value?.df || null,
    sizes: d.value?.sizes || null,
    vm, dockerReachable: ok,
    sampledAt: s.value?.at || null,
    diskSampledAt: d.value?.at || null,
    stale: { stats: s.stale, disk: d.stale },
  });
}

// ---- Access list (sharing) — admin only, enforced at route -----------------
async function getAccess(name) {
  if (!validateName(name)) return { status: 400, body: { error: { code: 'VALIDATION', message: 'invalid name' } } };
  const card = await resolveMachineCached(name);
  if (!card || !isPanelMachine(card)) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such machine' } } };
  return { status: 200, body: { name, owner: card.owner, sharedWith: shares.listFor(name) } };
}
async function putAccess(name, sharedWith) {
  if (!validateName(name)) return { status: 400, body: { error: { code: 'VALIDATION', message: 'invalid name' } } };
  if (!Array.isArray(sharedWith)) return { status: 400, body: { error: { code: 'VALIDATION', message: 'sharedWith must be an array' } } };
  if (sharedWith.length > 256) return { status: 400, body: { error: { code: 'VALIDATION', message: 'too many users' } } };
  const card = await resolveMachineCached(name);
  if (!card || !isPanelMachine(card)) return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'no such machine' } } };
  for (const u of sharedWith) {
    if (!validateUsername(u) || !users.get(u)) return { status: 400, body: { error: { code: 'VALIDATION', message: `unknown user: ${u}` } } };
    if (u === card.owner) return { status: 400, body: { error: { code: 'VALIDATION', message: 'owner already has access' } } };
  }
  const list = await shares.setList(name, sharedWith);
  return { status: 200, body: { ok: true, sharedWith: list } };
}

// ---- Rename (display name) — owner or admin --------------------------------
// The container NAME (the proxy URL /m/<name>/) never changes; this sets only a
// friendly label shown in the UI. Shared viewers cannot rename.
async function renameMachine(user, name, displayName) {
  if (typeof displayName !== 'string') return { status: 400, body: { error: { code: 'VALIDATION', message: 'displayName must be a string' } } };
  if (displayName.length > 64) return { status: 400, body: { error: { code: 'VALIDATION', message: 'name too long (max 64 characters)' } } };
  const resolved = await resolveMachine(user, name, 'use');
  if (resolved.error) return resolved.error;
  if (!canDelete(resolved.access)) return { status: 403, body: { error: { code: 'FORBIDDEN', message: 'Only the owner or an admin can rename this machine.' } } };
  const stored = await machineMeta.setDisplayName(name, displayName);
  invalidateMachineCache();
  return { status: 200, body: { ok: true, displayName: stored } };
}

// ---- Colima transitions (admin only, enforced at route) --------------------
async function colimaTransition(kind) {
  if (vmTransition) return { status: 409, body: { error: { code: 'JOB_IN_FLIGHT', message: 'VM already transitioning' } } };
  const current = parseColimaList((await run(COLIMA, ['list', '--json'], TIMEOUTS.read)).stdout);
  if (kind === 'starting' && current.running) return { status: 200, body: { ok: true, note: 'already running' } };
  if (kind === 'stopping' && !current.running) return { status: 200, body: { ok: true, note: 'already stopped' } };
  vmTransition = { kind, startedAt: Date.now() };
  const args = kind === 'starting' ? ['start'] : ['stop'];
  execFile(COLIMA, args, { timeout: TIMEOUTS.colima, maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
    const timedOut = !!(err && err.killed); // execFile kills on timeout → err.killed
    lastVmResult = {
      kind, ok: !err, timedOut, at: new Date().toISOString(),
      message: err ? (timedOut ? `Timed out after ${Math.round(TIMEOUTS.colima / 1000)}s` : String(stderr || err.message || 'failed').trim().slice(0, 300)) : null,
    };
    vmTransition = null; vmCache.invalidate(); invalidateMachineCache();
  });
  return { status: 202, body: { ok: true, transition: kind } };
}

// ---- Auth --------------------------------------------------------------------
// Returns { user, fullUser, session, sid } | null. Destroys sessions whose user
// vanished/disabled (replay-after-delete safety).
function authenticateRequest(req) {
  const resolved = sessions.resolve(req.headers.cookie);
  if (!resolved) return null;
  const full = users.get(resolved.session.username);
  if (!full || full.disabled) {
    sessions.destroy(resolved.sid).catch(() => {});
    return null;
  }
  return { user: UserStore.publicUser(full), fullUser: full, session: resolved.session, sid: resolved.sid, refreshedCookie: resolved.refreshedCookie };
}

function meBody(user) {
  return {
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
  };
}

// ---- HTTP plumbing ---------------------------------------------------------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
};

// CSP for the SPA shell (defense-in-depth atop esc()). The document frames
// machine SCREENS, which live on the second origin (machinePort / the HTTPS
// machine port), so frame-src must name that origin at the SAME hostname the
// panel was reached on. script-src stays 'self' (the shell has no inline JS —
// one external module); inline styles are allowed (low-risk, no script vector).
function panelCsp(req) {
  const host = String(req.headers.host || 'localhost');
  const hostname = host.replace(/:\d+$/, ''); // keep [::1] brackets intact
  const frames = ["'self'"];
  if (machinePort) frames.push(`http://${hostname}:${machinePort}`);
  if (config.publicTls && config.machineHttpsPort) {
    for (const h of publicHosts()) frames.push(`https://${h}:${config.machineHttpsPort}`);
    frames.push(`https://${hostname}:${config.machineHttpsPort}`);
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    `frame-src ${[...new Set(frames)].join(' ')}`,
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ');
}

function sendJson(res, status, body, extraHeaders = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': buf.length, ...SEC_HEADERS, ...extraHeaders });
  res.end(buf);
}
function sendText(res, status, text, extraHeaders = {}) {
  const buf = Buffer.from(text);
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length, ...SEC_HEADERS, ...extraHeaders });
  res.end(buf);
}
function sendHtml(res, status, html, extraHeaders = {}) {
  const buf = Buffer.from(html);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length, ...SEC_HEADERS, ...extraHeaders });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 65536) { reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' })); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw || '{}'); } catch { return null; }
}

// Mutations: Content-Type json + Origin (if present) must match host.
function guardMutation(req) {
  const bad = guardOriginOnly(req);
  if (bad) return bad;
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) return 'content-type must be application/json';
  return null;
}
// Origin-only guard (for binary uploads that are not JSON).
function guardOriginOnly(req) {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin, config.port, EXTRA_HOSTS) && !isPanelPublicOrigin(origin)) return 'bad origin';
  return null;
}

// ---- Static ----------------------------------------------------------------
const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};
const JS_MODULE_RE = /^\/js\/[a-z0-9/_-]+\.js$/;

function serveStatic(req, res, pathname) {
  let filePath; let type; let isHtml = false;
  if (STATIC[pathname]) {
    filePath = path.join(PUBLIC, STATIC[pathname].file);
    type = STATIC[pathname].type;
    isHtml = type.startsWith('text/html');
  } else if (JS_MODULE_RE.test(pathname)) {
    filePath = path.resolve(PUBLIC, '.' + pathname);
    if (!filePath.startsWith(path.join(PUBLIC, 'js') + path.sep)) return false;
    type = 'text/javascript; charset=utf-8';
  } else {
    return false;
  }
  // CSP governs the whole page from the shell document, so attach it there only.
  const csp = isHtml ? { 'Content-Security-Policy': panelCsp(req) } : {};
  fs.readFile(filePath, (err, buf) => {
    if (err) { sendText(res, 404, 'not found'); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': buf.length, ...SEC_HEADERS, ...csp });
    res.end(buf);
  });
  return true;
}

// ---- Access log ------------------------------------------------------------
let logStream = null;
let logBytes = 0;
const logPath = path.join(DATA_DIR, 'panel-access.log');
function openLogStream() {
  const s = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  // A disk-full / EPIPE on the log must never crash the panel — degrade to
  // no-logging instead (the crash-net would otherwise exit the process).
  s.on('error', () => { logStream = null; });
  return s;
}
if (config.accessLog) {
  try { logBytes = fs.statSync(logPath).size; } catch { logBytes = 0; }
  logStream = openLogStream();
}
function accessLog(remote, user, method, rawUrl, status, ms) {
  if (!logStream) return;
  const safeUrl = rawUrl.replace(/([?&](password|token)=)[^&]*/gi, '$1***');
  const line = `${new Date().toISOString()} ${remote} ${user || '-'} ${method} ${safeUrl} ${status} ${ms}ms\n`;
  logStream.write(line);
  logBytes += Buffer.byteLength(line);
  if (logBytes >= config.accessLogMaxBytes) {
    logStream.end();
    // Keep two generations: .1 -> .2, then current -> .1.
    try { fs.renameSync(`${logPath}.1`, `${logPath}.2`); } catch { /* no prior generation */ }
    try { fs.renameSync(logPath, `${logPath}.1`); } catch { /* ignore */ }
    logStream = openLogStream();
    logBytes = 0;
  }
}

// ---- Request handler -------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const remote = clientIp(req) || '-';
  let logUser = null;
  res.on('finish', () => accessLog(remote, logUser, req.method, req.url, res.statusCode, Date.now() - started));
  try {
    const rawPath = req.url.split('?')[0];
    const method = req.method;

    // Health check — unauthenticated, before host guard (leaks nothing).
    if (method === 'GET' && rawPath === '/healthz') return sendJson(res, 200, { ok: true });

    // Host guard (DNS-rebinding protection) on every request.
    if (!isAllowedHost(req.headers.host, config.port, EXTRA_HOSTS)) {
      return sendText(res, 400, 'Bad host');
    }

    // Prometheus metrics — an admin session OR a bearer token (config.metricsToken).
    if (method === 'GET' && rawPath === '/metrics') {
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = authenticateRequest(req);
      const ok = (a && a.user.role === 'admin') || (!!config.metricsToken && constantTimeEq(bearer, config.metricsToken));
      if (!ok) { res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer' }); return res.end('unauthorized'); }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(metrics.prometheus());
    }

    // External API for PRISM — bearer-token, server-to-server. Handled before the
    // session gate (PRISM has no cookie). OFF unless config.panelApiToken is set.
    if (rawPath.startsWith('/api/ext/')) return await handleExtApi(req, res, rawPath, method);

    // P0-2: machine screens live on the SECOND origin (MACHINE_PORT), never the
    // panel API origin. A stray /m/ hit here means an old link — point it there.
    if (rawPath.startsWith('/m/')) {
      const host = (req.headers.host || '').split(':')[0];
      res.writeHead(302, { Location: `http://${host}:${machinePort}${req.url}`, 'Cache-Control': 'no-store' });
      return res.end();
    }

    // ---- Static (SPA shell + JS modules; unauthenticated so login can load)
    if (method === 'GET' && (STATIC[rawPath] || JS_MODULE_RE.test(rawPath))) {
      if (serveStatic(req, res, rawPath)) return;
    }

    if (!rawPath.startsWith('/api/')) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such endpoint' } });

    // ---- Setup gate ------------------------------------------------------
    if (rawPath === '/api/setup') {
      if (method === 'GET') return sendJson(res, 200, { needed: users.isEmpty() });
      if (method === 'POST') return await handleSetup(req, res, (u) => { logUser = u; });
      return sendJson(res, 405, { error: { code: 'VALIDATION', message: 'method not allowed' } });
    }
    if (users.isEmpty()) return sendJson(res, 409, { error: { code: 'SETUP_REQUIRED', message: 'no users yet' } });

    // ---- Login (unauthenticated) -----------------------------------------
    if (rawPath === '/api/login' && method === 'POST') return await handleLogin(req, res, (u) => { logUser = u; });

    // ---- Authenticate ----------------------------------------------------
    const hadCookie = !!req.headers.cookie && req.headers.cookie.includes('vmp_session=');
    const auth = authenticateRequest(req);
    if (!auth) {
      const extra = hadCookie ? { 'Set-Cookie': sessions.clearCookie() } : {};
      return sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } }, extra);
    }
    logUser = auth.user.username;
    // Re-issue the cookie when the session TTL slid, so the client Max-Age tracks
    // the server. setHeader merges under writeHead; handlers that set their own
    // Set-Cookie (login/logout/change-pw) still take precedence for that key.
    if (auth.refreshedCookie) res.setHeader('Set-Cookie', auth.refreshedCookie);

    // Mutation guard for state-changing methods. File UPLOAD is exempt from the
    // JSON content-type check (it streams binary) but still gets the Origin check.
    if (method === 'POST' || method === 'DELETE' || method === 'PATCH' || method === 'PUT') {
      const isUpload = method === 'POST' && /^\/api\/machines\/[^/]+\/files\/[^/]+$/.test(rawPath);
      const bad = isUpload ? guardOriginOnly(req) : guardMutation(req);
      if (bad) return sendJson(res, 400, { error: { code: 'VALIDATION', message: bad } });

      // Throttle expensive machine/VM actions per user (docker spawns, uploads).
      if (/^\/api\/(machines|vm)(\/|$)/.test(rawPath)) {
        const rl = actionLimiter.hit(auth.user.username);
        if (!rl.allowed) {
          return sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many actions in a short time. Please wait a moment and try again.' } },
            { 'Retry-After': String(Math.max(1, Math.ceil(rl.retryAfterMs / 1000))) });
        }
      }
    }

    // Logout works regardless of mustChangePassword.
    if (rawPath === '/api/logout' && method === 'POST') {
      await sessions.destroy(auth.sid);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessions.clearCookie() });
    }
    if (rawPath === '/api/me' && method === 'GET') return sendJson(res, 200, meBody(auth.fullUser));
    if (rawPath === '/api/me/password' && method === 'PATCH') return await handleChangePassword(req, res, auth);

    // mustChangePassword gate — everything else blocked until changed.
    if (auth.fullUser.mustChangePassword) {
      return sendJson(res, 403, { error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'You must change your password first.' } });
    }

    // ---- Admin user management -------------------------------------------
    if (rawPath === '/api/users') {
      if (!isAdmin(auth)) return forbidden(res);
      if (method === 'GET') return await handleListUsers(res);
      if (method === 'POST') return await handleCreateUser(req, res, auth);
    }
    let m;
    if ((m = rawPath.match(/^\/api\/users\/([^/]+)$/))) {
      if (!isAdmin(auth)) return forbidden(res);
      const target = decodeURIComponent(m[1]);
      if (method === 'PATCH') return await handlePatchUser(req, res, auth, target);
      if (method === 'DELETE') return await handleDeleteUser(req, res, auth, target);
    }

    // ---- Machines --------------------------------------------------------
    if (rawPath === '/api/state' && method === 'GET') {
      return sendJson(res, 200, await getState(auth.user));
    }
    if (rawPath === '/api/templates' && method === 'GET') return sendJson(res, 200, listTemplates());
    if (rawPath === '/api/machines' && method === 'POST') {
      const body = await readJson(req);
      if (!body) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON' } });
      const out = await createMachine(auth.user, body.template, { name: body.name, viewers: body.viewers, cap: body.cap });
      if (out.status === 202) recordAudit(req, auth.user.username, 'machine.create', out.body.name, { template: String(body.template) });
      return sendJson(res, out.status, out.body);
    }
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)\/(start|stop|restart|unpause)$/)) && method === 'POST') {
      const out = await lifecycle(auth.user, decodeURIComponent(m[1]), m[2]);
      return sendJson(res, out.status, out.body);
    }
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)$/)) && method === 'DELETE') {
      const body = await readJson(req) || {};
      const out = await deleteMachine(auth.user, decodeURIComponent(m[1]), body.confirm);
      if (out.status === 200) recordAudit(req, auth.user.username, 'machine.delete', decodeURIComponent(m[1]));
      return sendJson(res, out.status, out.body);
    }
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)\/logs$/)) && method === 'GET') {
      const url = new URL(req.url, `http://${LOOPBACK}`);
      const out = await getLogs(auth.user, decodeURIComponent(m[1]), parseInt(url.searchParams.get('tail') || '500', 10));
      return sendText(res, out.status, out.text);
    }
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)\/ready$/)) && method === 'GET') {
      const out = await readiness(auth.user, decodeURIComponent(m[1]));
      return sendJson(res, out.status, out.body);
    }
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)\/stats$/)) && method === 'GET') {
      const out = await getMachineStats(auth.user, decodeURIComponent(m[1]));
      return sendJson(res, out.status, out.body);
    }
    if (rawPath === '/api/resources' && method === 'GET') {
      return sendJson(res, 200, await getResources(auth.user));
    }
    if (rawPath === '/api/usage' && method === 'GET') {
      if (!isAdmin(auth)) return forbidden(res);
      return sendJson(res, 200, { owners: usage.summary() });
    }
    // Connected-user session analytics (who used which machine, for how long).
    if (rawPath === '/api/analytics' && method === 'GET') {
      if (!isAdmin(auth)) return forbidden(res);
      const days = Math.min(365, Math.max(1, parseInt(new URL(req.url, `http://${LOOPBACK}`).searchParams.get('days') || '30', 10) || 30));
      const now = Date.now();
      const closed = usageSessions.closedList({ sinceMs: now - days * 86_400_000 });
      return sendJson(res, 200, summariseSessions(closed, usageSessions.liveList(), { now, days }));
    }
    if (rawPath === '/api/metrics' && method === 'GET') {
      if (!isAdmin(auth)) return forbidden(res);
      const n = Math.min(2880, Math.max(1, parseInt(new URL(req.url, `http://${LOOPBACK}`).searchParams.get('points') || '120', 10) || 120));
      return sendJson(res, 200, { series: metrics.series(n), latest: metrics.latest() });
    }
    // Live browser window on a Selenium node (capability: use).
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)\/browser$/))) {
      const name = decodeURIComponent(m[1]);
      if (method === 'POST') { const out = await openBrowserSession(auth.user, name); return sendJson(res, out.status, out.body); }
      if (method === 'DELETE') { const out = await closeBrowserSession(auth.user, name); return sendJson(res, out.status, out.body); }
    }
    // ---- File transfer (capability: use) ---------------------------------
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)\/files$/)) && method === 'GET') {
      const out = await listMachineFiles(auth.user, decodeURIComponent(m[1]));
      return sendJson(res, out.status, out.body);
    }
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)\/files\/(.+)$/))) {
      const name = decodeURIComponent(m[1]); const fn = decodeURIComponent(m[2]);
      if (method === 'GET') return await downloadMachineFile(auth.user, name, fn, res);
      if (method === 'POST') return await uploadMachineFile(auth.user, name, fn, req, res);
      if (method === 'DELETE') { const out = await deleteMachineFile(auth.user, name, fn); return sendJson(res, out.status, out.body); }
    }

    // ---- Access list / sharing (admin only) ------------------------------
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)\/access$/))) {
      if (!isAdmin(auth)) return forbidden(res);
      const name = decodeURIComponent(m[1]);
      if (method === 'GET') { const out = await getAccess(name); return sendJson(res, out.status, out.body); }
      if (method === 'PUT') {
        const body = await readJson(req);
        if (!body) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON' } });
        const out = await putAccess(name, body.sharedWith);
        if (out.status === 200) recordAudit(req, auth.user.username, 'machine.share', name, { sharedWith: out.body.sharedWith });
        return sendJson(res, out.status, out.body);
      }
    }

    // ---- Rename (display name) — owner or admin, enforced in renameMachine --
    if ((m = rawPath.match(/^\/api\/machines\/([^/]+)\/rename$/)) && method === 'PATCH') {
      const name = decodeURIComponent(m[1]);
      const body = await readJson(req);
      if (!body) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON' } });
      const out = await renameMachine(auth.user, name, body.displayName ?? '');
      if (out.status === 200) recordAudit(req, auth.user.username, 'machine.rename', name, { displayName: out.body.displayName });
      return sendJson(res, out.status, out.body);
    }

    // ---- VM control (admin only) -----------------------------------------
    if ((rawPath === '/api/vm/start' || rawPath === '/api/vm/stop') && method === 'POST') {
      if (!isAdmin(auth)) return forbidden(res);
      const out = await colimaTransition(rawPath.endsWith('start') ? 'starting' : 'stopping');
      if (out.status < 400) recordAudit(req, auth.user.username, rawPath.endsWith('start') ? 'vm.start' : 'vm.stop');
      return sendJson(res, out.status, out.body);
    }

    // ---- Audit log (admin-only) ------------------------------------------
    if (rawPath === '/api/audit' && method === 'GET') {
      if (!isAdmin(auth)) return forbidden(res);
      const limit = Math.min(1000, Math.max(1, parseInt(new URL(req.url, `http://${LOOPBACK}`).searchParams.get('limit') || '200', 10) || 200));
      return sendJson(res, 200, { entries: audit.list({ limit }) });
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
  } catch (e) {
    if (res.headersSent) return;
    // Malformed %-encoding in the path throws URIError from decodeURIComponent.
    if (e instanceof URIError) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'malformed URL encoding' } });
    if (e?.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE', message: 'request body too large' } });
    // Log the real error server-side; return an opaque message (no stderr/URI leak).
    try { console.error(`[VMP_ERR] ${new Date().toISOString()} ${req.method} ${req.url} ${e?.stack || e}`); } catch { /* ignore */ }
    sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
  }
});

function isAdmin(auth) { return auth.user.role === 'admin'; }
function forbidden(res) { return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'You do not have permission to do that.' } }); }

// ---- External API for PRISM (bearer-token, server-to-server) ---------------
// Lets PRISM manage assignments, provision machines, read analytics, and mint
// SSO links — all without a browser session. OFF unless config.panelApiToken is
// set. This is the ONLY surface another app can call; it never exposes secrets.
const EXT_BAD_JSON = { error: { code: 'VALIDATION', message: 'invalid JSON body' } };

// Hostname (no port), IPv6-literal-safe — mirrors panelFrameAncestors parsing.
function hostOnly(hostHeader) {
  const h = String(hostHeader || '');
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1) || 'localhost';
  const i = h.indexOf(':');
  return (i === -1 ? h : h.slice(0, i)) || 'localhost';
}
function originFor(req, tlsPort, plainPort) {
  // Behind the Caddy TLS front the panel sees an internal loopback Host header,
  // so the public origin MUST come from the configured publicHost (the cert
  // name), not from req.headers.host. Fall back to the request host only for the
  // plaintext LAN/localhost deployment where there is no publicHost.
  if (config.publicTls) {
    const host = config.publicHost || hostOnly(req.headers.host);
    return `https://${host}${tlsPort === 443 ? '' : ':' + tlsPort}`;
  }
  return `http://${hostOnly(req.headers.host)}:${plainPort}`;
}
const machineOriginFor = (req) => originFor(req, config.machineHttpsPort, machinePort);
const panelOriginFor = (req) => originFor(req, config.panelHttpsPort, config.port);

// A strong random password for ext-provisioned users. They never type it — they
// only ever arrive via SSO — but users.create requires one (>=10 chars).
function generatePassword(len = 24) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// Length-checked constant-time string compare (avoids leaking token length or
// prefix via early-exit timing). Empty inputs never match.
function constantTimeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extAuthOk(req) {
  if (!config.panelApiToken) return false;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return constantTimeEq(token, config.panelApiToken);
}

async function handleExtApi(req, res, rawPath, method) {
  // Feature-off looks like a non-existent endpoint (leaks nothing about config).
  if (!config.panelApiToken) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
  if (!extAuthOk(req)) { res.setHeader('WWW-Authenticate', 'Bearer'); return sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'bearer token required' } }); }
  const sub = rawPath.slice('/api/ext'.length);
  let m;

  // List all panel machines with their sharing ACL + screen path.
  if (sub === '/machines' && method === 'GET') {
    let cards = [];
    try { cards = await inspectCards(); } catch { /* docker down → empty */ }
    const machines = cards.filter(isPanelMachine).map((c) => ({
      name: c.name,
      displayName: machineMeta.displayName(c.name) || null,
      template: c.template,
      owner: c.owner,
      state: c.state,
      sharedWith: shares.listFor(c.name),
      createdAt: c.createdAt || null,
      screenPath: `/m/${c.name}/`,
    }));
    return sendJson(res, 200, { machines, machineOrigin: machineOriginFor(req) });
  }

  // List VM users (no secrets).
  if (sub === '/users' && method === 'GET') {
    return sendJson(res, 200, { users: users.list().map((u) => UserStore.publicUser(u)) });
  }

  // Ensure a VM user exists (idempotent). Body: { username, role? }.
  if (sub === '/users' && method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, EXT_BAD_JSON);
    const username = String(body.username || '').toLowerCase();
    if (!validateUsername(username)) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid username (3–32 lowercase letters/digits/_/-, starts with a letter)' } });
    const role = body.role === 'admin' ? 'admin' : 'user';
    const existing = users.get(username);
    if (existing) return sendJson(res, 200, { ok: true, created: false, user: UserStore.publicUser(existing) });
    try {
      const user = await users.create({ username, password: generatePassword(), role, mustChangePassword: false });
      recordAudit(req, 'prism', 'user.create', username, { role, via: 'ext' });
      return sendJson(res, 201, { ok: true, created: true, user: UserStore.publicUser(user) });
    } catch (e) {
      if (e.code === 'USER_EXISTS') { const u = users.get(username); return sendJson(res, 200, { ok: true, created: false, user: u ? UserStore.publicUser(u) : null }); }
      throw e;
    }
  }

  // Get / set a machine's share ACL (assign & unassign). PUT body: { sharedWith: [] }.
  if ((m = sub.match(/^\/machines\/([^/]+)\/access$/))) {
    const name = decodeURIComponent(m[1]);
    if (method === 'GET') { const out = await getAccess(name); return sendJson(res, out.status, out.body); }
    if (method === 'PUT') {
      const body = await readJson(req);
      if (!body) return sendJson(res, 400, EXT_BAD_JSON);
      const out = await putAccess(name, body.sharedWith);
      if (out.status === 200) { invalidateMachineCache(); recordAudit(req, 'prism', 'machine.access', name, { sharedWith: body.sharedWith }); }
      return sendJson(res, out.status, out.body);
    }
  }

  // Provision a machine owned by a target user. Body: { owner, template, name?, viewers?, cap? }.
  if (sub === '/machines' && method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, EXT_BAD_JSON);
    const owner = String(body.owner || body.username || '').toLowerCase();
    if (!validateUsername(owner) || !users.get(owner)) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'unknown owner user' } });
    // Act as an admin-capable actor OWNED by the target (custom name/viewers OK,
    // no per-user quota) — provisioning is an administrative operation.
    const out = await createMachine({ username: owner, role: 'admin' }, body.template, { name: body.name, viewers: body.viewers, cap: body.cap });
    if (out.status < 300) { invalidateMachineCache(); recordAudit(req, 'prism', 'machine.create', out.body?.name || body.name || null, { template: body.template, owner, via: 'ext' }); }
    return sendJson(res, out.status, out.body);
  }

  // Usage analytics feed (same shape as GET /api/analytics).
  if (sub === '/analytics' && method === 'GET') {
    const days = Math.min(365, Math.max(1, parseInt(new URL(req.url, `http://${LOOPBACK}`).searchParams.get('days') || '30', 10) || 30));
    const now = Date.now();
    const closed = usageSessions.closedList({ sinceMs: now - days * 86_400_000 });
    return sendJson(res, 200, summariseSessions(closed, usageSessions.liveList(), { now, days }));
  }

  // Mint a one-time SSO link for a user (+ optional machine) to embed in PRISM.
  if (sub === '/sso/mint' && method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, EXT_BAD_JSON);
    const username = String(body.username || '').toLowerCase();
    if (!validateUsername(username)) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid username' } });
    const user = users.get(username);
    if (!user) return sendJson(res, 404, { error: { code: 'USER_NOT_FOUND', message: 'no such user' } });
    if (user.disabled) return sendJson(res, 403, { error: { code: 'USER_DISABLED', message: 'user is disabled' } });
    const machine = body.machine ? String(body.machine) : null;
    if (machine && !validateName(machine)) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid machine name' } });
    const ttlSec = Math.min(300, Math.max(15, parseInt(body.ttlSec, 10) || 60));
    const now = Date.now();
    const token = mintSsoToken(SECRET, { username, machine, ttlSec, now });
    const link = `/sso?t=${encodeURIComponent(token)}`;
    recordAudit(req, 'prism', 'sso.mint', username, { machine, via: 'ext' });
    return sendJson(res, 200, { ok: true, token, path: link, url: machineOriginFor(req) + link, expiresAt: new Date(now + ttlSec * 1000).toISOString() });
  }

  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
}

// Redeem a one-time SSO token (browser GET on the machine origin): set an embed
// session cookie, then redirect into the machine screen. Enables the fully
// embedded desktop inside PRISM without the user logging into the panel.
async function handleSsoRedeem(req, res, setUser) {
  if (!config.panelApiToken) return sendHtml(res, 404, errorPage(404, 'Not found', 'Single sign-on is not enabled on this panel.'));
  const url = new URL(req.url, `http://${req.headers.host || LOOPBACK}`);
  const now = Date.now();
  const payload = verifySsoToken(SECRET, url.searchParams.get('t') || '', { now });
  if (!payload) return sendHtml(res, 401, errorPage(401, 'Sign-in link expired', 'This link is invalid or has expired. Return to PRISM and open the desktop again.'));
  if (!ssoGuard.claim(payload.jti, payload.exp)) return sendHtml(res, 401, errorPage(401, 'Link already used', 'This sign-in link was already used. Return to PRISM and open the desktop again.'));
  const user = users.get(payload.username);
  if (!user || user.disabled) return sendHtml(res, 403, errorPage(403, 'No access', 'This account cannot sign in.'));
  const { setCookie } = await sessions.create(payload.username, { ip: clientIp(req), userAgent: req.headers['user-agent'], embed: true });
  setUser?.(payload.username);
  recordAudit(req, payload.username, 'sso.login', payload.machine || null, { via: 'prism-embed' });
  // Redirect into the machine's REAL viewer URL (card.uiUrl = autoconnect +
  // resize + the websockify `path=` + any password), never the bare /m/<name>/
  // landing — that shows a manual "Connect" button and cannot find the socket
  // ("Failed to connect to server"). For browser nodes, kick off the WebDriver
  // session so the node opens straight into Chrome/Firefox, mirroring the
  // panel's own open flow. No machine → the panel SPA on its own origin.
  let dest = `${panelOriginFor(req)}/`;
  if (payload.machine) {
    let card = null;
    try { card = await resolveMachineCached(payload.machine); } catch { /* ignore */ }
    if (card && isPanelMachine(card) && card.uiUrl) {
      const t = TEMPLATES[card.template];
      if (card.webdriver && t?.wdBrowserName && card.state === 'running') {
        openBrowserSession({ username: payload.username, role: user.role }, payload.machine).catch(() => {});
      }
      dest = card.uiUrl;
    } else {
      dest = `/m/${encodeURIComponent(payload.machine)}/`;
    }
  }
  // No X-Frame-Options here: this 302 travels inside the PRISM iframe. The final
  // screen document's framing is governed by its CSP frame-ancestors allow-list.
  res.writeHead(302, { Location: dest, 'Set-Cookie': setCookie, 'Cache-Control': 'no-store' });
  return res.end();
}

// ---- Route handlers --------------------------------------------------------
async function handleSetup(req, res, setUser) {
  if (!users.isEmpty()) return sendJson(res, 409, { error: { code: 'SETUP_ALREADY_DONE', message: 'setup already completed' } });
  const bad = guardMutation(req);
  if (bad) return sendJson(res, 400, { error: { code: 'VALIDATION', message: bad } });
  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON' } });
  const { username, password } = body;
  if (!validateUsername(username)) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'Username must be 3–32 lowercase letters, digits, _ or -, starting with a letter.' } });
  const pwErr = validatePassword(password);
  if (pwErr) return sendJson(res, 400, { error: { code: 'WEAK_PASSWORD', message: pwErr } });
  if (!users.isEmpty()) return sendJson(res, 409, { error: { code: 'SETUP_ALREADY_DONE', message: 'setup already completed' } });
  const user = await users.create({ username, password, role: 'admin', mustChangePassword: false });
  const { setCookie } = await sessions.create(username, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
  setUser(username);
  recordAudit(req, username, 'setup', username, { role: 'admin' });
  return sendJson(res, 201, { ok: true, user: meBody(user) }, { 'Set-Cookie': setCookie });
}

async function handleLogin(req, res, setUser) {
  const bad = guardMutation(req);
  if (bad) return sendJson(res, 400, { error: { code: 'VALIDATION', message: bad } });
  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON' } });
  const username = String(body.username || '').toLowerCase();
  const password = String(body.password || '');
  const ip = clientIp(req) || '';
  const gate = loginLimiter.check(ip, username);
  if (!gate.allowed) {
    const retryAfter = Math.max(1, Math.ceil(gate.retryAfterMs / 1000));
    // retryAfter is echoed in the body too — the client can't read the header (CORS-less fetch helper).
    return sendJson(res, 429, { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' }, retryAfter }, { 'Retry-After': String(retryAfter) });
  }
  const user = await users.verifyCredentials(username, password);
  if (!user) {
    loginLimiter.recordFailure(ip, username);
    recordAudit(req, username || '(unknown)', 'login.fail');
    return sendJson(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password.' } });
  }
  loginLimiter.recordSuccess(ip, username);
  const { setCookie } = await sessions.create(user.username, { ip, userAgent: req.headers['user-agent'] });
  setUser(user.username);
  recordAudit(req, user.username, 'login.success');
  return sendJson(res, 200, { ok: true, user: meBody(user) }, { 'Set-Cookie': setCookie });
}

async function handleChangePassword(req, res, auth) {
  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON' } });
  const { currentPassword, newPassword } = body;
  const verified = await users.verifyCredentials(auth.user.username, String(currentPassword || ''));
  if (!verified) return sendJson(res, 401, { error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' } });
  const pwErr = validatePassword(newPassword);
  if (pwErr) return sendJson(res, 400, { error: { code: 'WEAK_PASSWORD', message: pwErr } });
  await users.setPassword(auth.user.username, newPassword, { mustChangePassword: false });
  await sessions.destroyForUser(auth.user.username, auth.sid); // keep current session
  return sendJson(res, 200, { ok: true });
}

async function handleListUsers(res) {
  let cards = [];
  try { cards = await inspectCards(); } catch { /* VM down: report zero machines */ }
  const list = users.list().map((u) => {
    const owned = cards.filter((c) => c.owner === u.username);
    return {
      ...UserStore.publicUser(u),
      machines: { total: owned.length, running: owned.filter((c) => c.state === 'running').length },
      sessions: sessions.countForUser(u.username),
    };
  });
  return sendJson(res, 200, { users: list });
}

async function handleCreateUser(req, res, auth) {
  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON' } });
  const { username, password, role = 'user' } = body;
  if (!validateUsername(username)) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'Username must be 3–32 lowercase letters, digits, _ or -, starting with a letter.' } });
  if (role !== 'user' && role !== 'admin') return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid role' } });
  const pwErr = validatePassword(password);
  if (pwErr) return sendJson(res, 400, { error: { code: 'WEAK_PASSWORD', message: pwErr } });
  try {
    const user = await users.create({ username, password, role, mustChangePassword: true });
    recordAudit(req, auth.user.username, 'user.create', username, { role });
    return sendJson(res, 201, { ok: true, user: meBody(user) });
  } catch (e) {
    if (e.code === 'USER_EXISTS') return sendJson(res, 409, { error: { code: 'USER_EXISTS', message: 'That username is already taken.' } });
    throw e;
  }
}

async function handlePatchUser(req, res, auth, target) {
  const t = users.get(target);
  if (!t) return sendJson(res, 404, { error: { code: 'USER_NOT_FOUND', message: 'no such user' } });
  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid JSON' } });

  if (typeof body.password === 'string') {
    const pwErr = validatePassword(body.password);
    if (pwErr) return sendJson(res, 400, { error: { code: 'WEAK_PASSWORD', message: pwErr } });
    await users.setPassword(target, body.password, { mustChangePassword: true });
    await sessions.destroyForUser(target);
    killTunnelsForUser(target);
  }
  if (typeof body.role === 'string') {
    if (body.role !== 'user' && body.role !== 'admin') return sendJson(res, 400, { error: { code: 'VALIDATION', message: 'invalid role' } });
    if (body.role !== 'admin' && users.isLastActiveAdmin(target)) return sendJson(res, 409, { error: { code: 'LAST_ADMIN', message: 'You cannot demote the last administrator.' } });
    await users.setRole(target, body.role);
  }
  if (typeof body.disabled === 'boolean') {
    if (body.disabled && users.isLastActiveAdmin(target)) return sendJson(res, 409, { error: { code: 'LAST_ADMIN', message: 'You cannot disable the last administrator.' } });
    await users.setDisabled(target, body.disabled);
    if (body.disabled) { await sessions.destroyForUser(target); killTunnelsForUser(target); }
  }
  recordAudit(req, auth.user.username, 'user.update', target, {
    ...(typeof body.password === 'string' ? { passwordReset: true } : {}),
    ...(typeof body.role === 'string' ? { role: body.role } : {}),
    ...(typeof body.disabled === 'boolean' ? { disabled: body.disabled } : {}),
  });
  return sendJson(res, 200, { ok: true, user: meBody(users.get(target)) });
}

async function handleDeleteUser(req, res, auth, target) {
  const t = users.get(target);
  if (!t) return sendJson(res, 404, { error: { code: 'USER_NOT_FOUND', message: 'no such user' } });
  if (target === auth.user.username) return sendJson(res, 409, { error: { code: 'SELF_FORBIDDEN', message: 'Another administrator must delete your account.' } });
  if (users.isLastActiveAdmin(target)) return sendJson(res, 409, { error: { code: 'LAST_ADMIN', message: 'You cannot delete the last administrator.' } });
  const body = await readJson(req) || {};

  const deleted = []; const failed = [];
  if (body.deleteMachines) {
    let cards = [];
    try { cards = await inspectCards(); } catch { /* VM down */ }
    for (const c of cards.filter((c) => c.owner === target && !PROTECTED_NAMES.has(c.name))) {
      inFlight.add(c.name);
      try {
        if (await rmContainer(c.name)) { deleted.push(c.name); await shares.removeMachine(c.name); await machineMeta.removeMachine(c.name); }
        else failed.push({ name: c.name, error: 'rm failed' });
      } finally { inFlight.delete(c.name); }
    }
    invalidateMachineCache();
  }
  await sessions.destroyForUser(target);
  killTunnelsForUser(target);
  await shares.removeUser(target);   // scrub target from every access list
  await users.remove(target);
  recordAudit(req, auth.user.username, 'user.delete', target, { deletedMachines: deleted.length });
  return sendJson(res, 200, { ok: true, deletedMachines: deleted, failed });
}

// ---- Proxy handlers --------------------------------------------------------
// The panel origin that is allowed to frame a machine screen. Derived from the
// machine request's own Host (same hostname, panel port) so it matches whatever
// the browser actually used — localhost, LAN IP, or an mDNS name — with no
// hard-coded host. Used for the screens' CSP frame-ancestors allow-list.
function panelFrameAncestors(req) {
  const h = String(req.headers.host || '');
  let host;
  if (h.startsWith('[')) host = h.slice(0, h.indexOf(']') + 1); // IPv6 literal, keep brackets
  else { const i = h.indexOf(':'); host = i === -1 ? h : h.slice(0, i); }
  host = host || 'localhost';
  const parts = [`'self'`, `http://${host}:${config.port}`, `https://${host}:${config.port}`];
  // Behind the Caddy TLS front the panel page loads from its public HTTPS origin;
  // allow it to frame the screens. Include the port-less :443 form (browsers omit
  // the default port) so framing is not blocked on a :443 deployment.
  for (const o of publicOrigins(config.panelHttpsPort)) parts.push(o);
  // External apps explicitly allowed to embed the screens (e.g. the PRISM app).
  for (const o of config.embedOrigins || []) parts.push(o);
  return parts.join(' ');
}

// Per-template backend transport: Kasm media desktops speak HTTPS with Basic auth
// (satisfied server-side so the embedded screen never prompts); noVNC is plain.
function backendProxyOpts(card) {
  const t = TEMPLATES[card.template] || {};
  return { backendTls: !!t.backendTls, backendAuth: t.backendAuth || null };
}

// Pick the backend port + target path for a proxied request. Almost everything
// goes to the UI port (KasmVNC web + VNC websocket). The one exception is the
// desktop audio-out stream: the client's /m/<name>/kasmaudio request is routed
// to the container's separate audio websocket server (published as card.audioPort,
// which serves at "/"), so desktop speaker audio works over the same proxy.
function proxyRoute(card, parsed) {
  const rest = parsed.rest || '';
  if (card.audioPort && /^\/kasmaudio(?:[/?]|$)/.test(rest)) {
    return { port: card.audioPort, target: '/' };
  }
  // Microphone WS — keep the query (?sample_rate=N) the audio-input server needs.
  if (card.micPort && /^\/kasmmic(?:[/?]|$)/.test(rest)) {
    return { port: card.micPort, target: '/' + parsed.query };
  }
  return { port: card.uiPort, target: rest + parsed.query };
}

async function handleProxy(req, res, setUser) {
  const auth = authenticateRequest(req);
  if (!auth) {
    // Navigations → send to login; subresources → 401.
    if ((req.headers.accept || '').includes('text/html')) {
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendText(res, 401, 'Unauthenticated');
  }
  if (auth.fullUser.mustChangePassword) return sendHtml(res, 403, errorPage(403, 'Password change required', 'Set a new password in PRISM Virtual Desktop before opening machines.'));
  setUser(auth.user.username);

  const parsed = parseProxyPath(req.url);
  if (!parsed) return sendHtml(res, 404, errorPage(404, 'Not found', 'That machine path is not valid.'));
  if (parsed.rest === null) {
    res.writeHead(302, { Location: `/m/${parsed.name}/${parsed.query}`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  let card;
  try { card = await resolveMachineCached(parsed.name); }
  catch { card = null; }
  if (!card || !isPanelMachine(card) || !canUse(accessFor(auth.user, card))) return sendHtml(res, 404, errorPage(404, 'Machine not found', 'This machine does not exist or is not yours.'));
  if (card.localOnly || !card.uiPort) return sendHtml(res, 502, errorPage(502, 'Not available here', 'This machine can only be opened on the host Mac.'));
  if (card.state !== 'running') return sendHtml(res, 502, errorPage(502, 'Machine is not running', `“${parsed.name}” is stopped. Start it from PRISM Virtual Desktop, then try again.`));
  touchMachine(parsed.name); // idle-reaper activity signal
  const route = proxyRoute(card, parsed);
  proxyHttp({ req, res, port: route.port, target: route.target, name: parsed.name, frameAncestors: panelFrameAncestors(req), ...backendProxyOpts(card) });
}

// Kill any live proxied tunnels belonging to a user (revocation on disable/
// delete/password-reset). Sockets are tagged with _vmpUser in the upgrade path.
function killTunnelsForUser(username) {
  for (const s of upgradedSockets) if (s._vmpUser === username) s.destroy();
}

// Shared WebSocket upgrade handler for the machine origin.
async function handleUpgrade(req, socket, head) {
  // P0-1: error listener BEFORE any await, or a client RST during the docker
  // lookup emits an unhandled 'error' and crashes the process.
  socket.on('error', () => socket.destroy());
  try {
    if (!isAllowedHost(req.headers.host, machinePort, EXTRA_HOSTS)) { socket.destroy(); return; }
    // Defense-in-depth (atop SameSite=Lax): if a browser sends an Origin, it must
    // be the machine origin (the screen iframe). Absent Origin = non-browser client.
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin, machinePort, EXTRA_HOSTS) && !isMachinePublicOrigin(origin)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    const auth = authenticateRequest(req);
    if (!auth || auth.fullUser.mustChangePassword) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    const parsed = parseProxyPath(req.url);
    if (!parsed || parsed.rest === null) { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    let card;
    try { card = await resolveMachineCached(parsed.name); } catch { card = null; }
    if (!card || !isPanelMachine(card) || !canUse(accessFor(auth.user, card)) || card.localOnly || !card.uiPort || card.state !== 'running') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    // The client can disconnect DURING the async docker lookup above. If so,
    // bail before incrementing ref-counts — the 'close' listener below is
    // registered too late to fire for an already-closed socket, which would
    // otherwise leak the machine open-count and the usage session forever.
    if (socket.destroyed) return;
    socket._vmpUser = auth.user.username; // tag for revocation
    // Track an open screen connection so the idle reaper never stops a machine
    // someone is actively viewing, AND attribute usage to the CONNECTED user
    // (ref-counted — screen + kasmaudio + kasmmic are separate upgrades).
    openMachineConn(parsed.name);
    usageSessions.open(auth.user.username, parsed.name, { template: card.template, owner: card.owner, ip: clientIp(req) });
    socket.once('close', () => { closeMachineConn(parsed.name); usageSessions.close(auth.user.username, parsed.name); });
    const route = proxyRoute(card, parsed);
    proxyUpgrade({ req, socket, head, port: route.port, target: route.target, upgradedSockets, maxSockets: config.maxUpgradedSockets, ...backendProxyOpts(card) });
  } catch {
    socket.destroy();
  }
}

// ---- Machine origin (P0-2): a SECOND server that serves ONLY /m/ ----------
const machineServer = http.createServer(async (req, res) => {
  const started = Date.now();
  const remote = clientIp(req) || '-';
  let logUser = null;
  res.on('finish', () => accessLog(remote, logUser, req.method, req.url, res.statusCode, Date.now() - started));
  try {
    const rawPath = req.url.split('?')[0];
    if (req.method === 'GET' && rawPath === '/healthz') return sendJson(res, 200, { ok: true });
    if (!isAllowedHost(req.headers.host, machinePort, EXTRA_HOSTS)) return sendText(res, 400, 'Bad host');
    // One-time SSO redeem → sets an embed cookie and redirects into the screen.
    if (req.method === 'GET' && rawPath === '/sso') return await handleSsoRedeem(req, res, (u) => { logUser = u; });
    if (rawPath.startsWith('/m/')) return await handleProxy(req, res, (u) => { logUser = u; });
    return sendHtml(res, 404, errorPage(404, 'Not found', 'Machine screens are served here; open the panel to pick one.'));
  } catch (e) {
    if (!res.headersSent) sendText(res, 500, 'error');
  }
});
machineServer.on('upgrade', handleUpgrade);
// The panel API origin serves no WebSockets — reject upgrades there outright.
server.on('upgrade', (req, socket) => { socket.on('error', () => socket.destroy()); socket.destroy(); });

// ---- Server lifecycle ------------------------------------------------------
for (const s of [server, machineServer]) {
  s.headersTimeout = 10_000;
  s.requestTimeout = 120_000;
  s.keepAliveTimeout = 5_000;
  s.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error(`Port in use (${config.port}/${machinePort}). Is VM Panel already running?`); process.exit(1); }
    throw e;
  });
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Hard deadline so a hung flush can never wedge the restart.
  const timer = setTimeout(() => process.exit(0), 5000);
  timer.unref();
  server.close();
  machineServer.close();
  server.closeAllConnections?.();
  machineServer.closeAllConnections?.();
  for (const s of upgradedSockets) s.destroy();
  // AWAIT the debounced writes — otherwise a kickstart/SIGTERM drops up to ~30s
  // of session/usage/metrics data that was only scheduled to flush.
  try { await Promise.allSettled([sessions.flush(), usage.flush(), usageSessions.flush(), metrics.flush()]); } catch { /* best-effort */ }
  logStream?.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Crash-safety net: a stray uncaught error otherwise exits the process and launchd
// (KeepAlive SuccessfulExit=false) silently restarts it every ~10s. Log a tagged,
// greppable line AND fire the alert webhook (best-effort) so a crash-loop is never
// invisible, then exit non-zero. Also catches the non-EADDRINUSE server 'error'.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    if (shuttingDown) return;
    fatalExit(`${event}: ${err?.stack || err}`);
  });
}

server.listen(config.port, config.bind, () => {
  const bound = server.address()?.port ?? config.port;
  config.port = bound; // align host/origin guards when bound to an ephemeral port
  machineServer.listen(config.port === bound && machinePort !== 0 ? machinePort : 0, config.bind, () => {
    machinePort = machineServer.address()?.port ?? machinePort;
    const lan = config.lanHost || pickLanAddress(os.networkInterfaces());
    console.log(`VM Panel on http://${config.bind}:${bound}` + (lan ? `  (LAN: http://${lan}:${bound})` : ''));
    console.log(`Machine screens on port ${machinePort}`);
    console.log(`VMP_LISTENING port=${bound} machinePort=${machinePort}`);
    if (users.isEmpty()) console.log('First run: open the panel to create your admin account.');
    reattachBrowserSessions().catch(() => {}); // re-adopt live browsers after a restart
    try { sweepStale(os.tmpdir(), 'vmp-', 60 * 60 * 1000); } catch { /* best-effort */ } // clear crashed-upload scratch
  });
});
