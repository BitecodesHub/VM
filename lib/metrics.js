// MetricsStore — a tiny in-memory ring of aggregate time-series points, persisted
// (debounced) so a short window of history survives a restart. Sampled once a
// minute by the server's maintenance tick. Powers /metrics (Prometheus text),
// /api/metrics (JSON series for the Resources sparkline), and threshold alerts.

import { loadJsonFile, atomicWriteJson } from './store.js';

export class MetricsStore {
  // maxPoints 2880 × 60s ≈ 48h of 1-minute history.
  constructor(filePath, { maxPoints = 2880, flushDebounceMs = 60_000, now = Date.now } = {}) {
    this.filePath = filePath;
    this.maxPoints = maxPoints;
    this.flushDebounceMs = flushDebounceMs;
    this.now = now;
    this.points = [];
    this._timer = null;
    this._dirty = false;
  }

  load() {
    const data = loadJsonFile(this.filePath, { version: 1, points: [] });
    this.points = Array.isArray(data.points) ? data.points.slice(-this.maxPoints) : [];
    return this;
  }

  // point: { vmRunning, memUsed, memTotal, cpuPct, cpuCores, diskUsed, diskTotal, running }
  record(point) {
    this.points.push({ at: new Date(this.now()).toISOString(), ...point });
    if (this.points.length > this.maxPoints) this.points.splice(0, this.points.length - this.maxPoints);
    this._scheduleFlush();
  }

  latest() { return this.points[this.points.length - 1] || null; }

  // Recent series, newest last, optionally limited to the last `n` points.
  series(n) { return n ? this.points.slice(-n) : this.points.slice(); }

  // Prometheus text exposition of the latest sample (empty-safe).
  prometheus() {
    const p = this.latest();
    const L = [];
    const g = (name, help, val) => { L.push(`# HELP ${name} ${help}`); L.push(`# TYPE ${name} gauge`); L.push(`${name} ${Number.isFinite(val) ? val : 0}`); };
    g('vmpanel_up', 'Panel is serving', 1);
    g('vmpanel_vm_running', 'Docker VM running', p?.vmRunning ? 1 : 0);
    g('vmpanel_mem_used_bytes', 'Memory used by all containers', p?.memUsed);
    g('vmpanel_mem_total_bytes', 'Memory available to the VM', p?.memTotal);
    g('vmpanel_cpu_percent', 'CPU percent used across containers', p?.cpuPct);
    g('vmpanel_cpu_cores', 'CPU cores available', p?.cpuCores);
    g('vmpanel_disk_used_bytes', 'Disk used', p?.diskUsed);
    g('vmpanel_disk_total_bytes', 'Disk total', p?.diskTotal);
    g('vmpanel_machines_running', 'Running panel machines', p?.running);
    return L.join('\n') + '\n';
  }

  _scheduleFlush() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; if (this._dirty) this._persist().catch(() => {}); }, this.flushDebounceMs);
    this._timer.unref?.();
  }
  async flush() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } if (this._dirty) await this._persist(); }
  async _persist() { this._dirty = false; await atomicWriteJson(this.filePath, { version: 1, points: this.points }); }
}

// Pure alert derivation from a metrics point + thresholds. Returns
// [{ id, level, title }] — level is 'warning' | 'critical'. Stateless + testable.
export function deriveAlerts(point, {
  memWarn = 85, memCrit = 95, diskWarn = 85, diskCrit = 95,
  backupAgeMs = null, backupStaleMs = 48 * 60 * 60 * 1000,
} = {}) {
  const out = [];
  if (!point) return out;
  if (point.vmRunning === false) { out.push({ id: 'vm-down', level: 'critical', title: 'The Docker VM is not running — machines are unavailable.' }); return out; }
  const memPct = point.memTotal ? (point.memUsed / point.memTotal) * 100 : 0;
  if (memPct >= memCrit) out.push({ id: 'mem', level: 'critical', title: `Memory ${memPct.toFixed(0)}% used — machines may be killed. Stop something.` });
  else if (memPct >= memWarn) out.push({ id: 'mem', level: 'warning', title: `Memory ${memPct.toFixed(0)}% used — nearing capacity.` });
  const diskPct = point.diskTotal ? (point.diskUsed / point.diskTotal) * 100 : 0;
  if (diskPct >= diskCrit) out.push({ id: 'disk', level: 'critical', title: `Disk ${diskPct.toFixed(0)}% used — creates/uploads will start failing.` });
  else if (diskPct >= diskWarn) out.push({ id: 'disk', level: 'warning', title: `Disk ${diskPct.toFixed(0)}% used — nearing full.` });
  // A container failing its Docker HEALTHCHECK: serving but likely broken.
  const unhealthy = point.unhealthy || 0;
  if (unhealthy > 0) out.push({ id: 'unhealthy', level: 'warning', title: `${unhealthy} machine${unhealthy > 1 ? 's are' : ' is'} unhealthy — a restart may fix it.` });
  // Backup staleness — only when a backup was EVER taken (age known), so an
  // unconfigured LAN box never nags. Missing status file ⇒ backupAgeMs null ⇒ skip.
  if (backupAgeMs != null && backupAgeMs > backupStaleMs) {
    const days = Math.max(1, Math.floor(backupAgeMs / (24 * 60 * 60 * 1000)));
    out.push({ id: 'backup-stale', level: 'warning', title: `Last backup was ${days} day${days === 1 ? '' : 's'} ago — check the backup job.` });
  }
  return out;
}
