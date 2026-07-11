import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetricsStore, deriveAlerts } from '../lib/metrics.js';

function tmp() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-metrics-')), 'metrics.json'); }

test('MetricsStore rings to maxPoints and persists/reloads', async () => {
  const f = tmp();
  const m = new MetricsStore(f, { maxPoints: 3 });
  for (let i = 0; i < 5; i++) m.record({ memUsed: i });
  assert.equal(m.series().length, 3, 'trimmed to maxPoints');
  assert.equal(m.latest().memUsed, 4);
  await m.flush();
  const r = new MetricsStore(f, { maxPoints: 3 }).load();
  assert.equal(r.latest().memUsed, 4);
});

test('MetricsStore.prometheus emits gauges (empty-safe)', () => {
  const m = new MetricsStore(tmp());
  assert.match(m.prometheus(), /vmpanel_up 1/);
  m.record({ vmRunning: true, memUsed: 100, memTotal: 200, running: 2 });
  const text = m.prometheus();
  assert.match(text, /vmpanel_vm_running 1/);
  assert.match(text, /vmpanel_mem_used_bytes 100/);
  assert.match(text, /vmpanel_machines_running 2/);
});

test('deriveAlerts: vm-down dominates; mem/disk warn+crit thresholds', () => {
  assert.deepEqual(deriveAlerts(null), []);
  assert.equal(deriveAlerts({ vmRunning: false })[0].id, 'vm-down');
  const ok = deriveAlerts({ vmRunning: true, memUsed: 10, memTotal: 100, diskUsed: 10, diskTotal: 100 });
  assert.equal(ok.length, 0, 'healthy → no alerts');
  const warn = deriveAlerts({ vmRunning: true, memUsed: 88, memTotal: 100, diskUsed: 0, diskTotal: 100 });
  assert.equal(warn[0].level, 'warning');
  const crit = deriveAlerts({ vmRunning: true, memUsed: 96, memTotal: 100, diskUsed: 99, diskTotal: 100 });
  assert.ok(crit.some((a) => a.id === 'mem' && a.level === 'critical'));
  assert.ok(crit.some((a) => a.id === 'disk' && a.level === 'critical'));
});

test('deriveAlerts: unhealthy-container warning', () => {
  const base = { vmRunning: true, memUsed: 1, memTotal: 100, diskUsed: 1, diskTotal: 100 };
  assert.equal(deriveAlerts({ ...base, unhealthy: 0 }).some((a) => a.id === 'unhealthy'), false);
  const a = deriveAlerts({ ...base, unhealthy: 2 }).find((x) => x.id === 'unhealthy');
  assert.equal(a.level, 'warning');
  assert.match(a.title, /2 machines are unhealthy/);
});

test('deriveAlerts: backup-staleness only when a backup age is known and old', () => {
  const base = { vmRunning: true, memUsed: 1, memTotal: 100, diskUsed: 1, diskTotal: 100 };
  // Never backed up (null) → no nag.
  assert.equal(deriveAlerts(base, { backupAgeMs: null }).some((a) => a.id === 'backup-stale'), false);
  // Fresh backup → no nag.
  assert.equal(deriveAlerts(base, { backupAgeMs: 60 * 60 * 1000 }).some((a) => a.id === 'backup-stale'), false);
  // 3 days old → warn.
  const stale = deriveAlerts(base, { backupAgeMs: 3 * 24 * 60 * 60 * 1000 }).find((a) => a.id === 'backup-stale');
  assert.equal(stale.level, 'warning');
  assert.match(stale.title, /3 days ago/);
});
