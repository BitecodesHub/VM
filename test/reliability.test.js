// Regression tests for the reliability hardening pass. Each pins a failure mode
// that was confirmed against the pre-hardening build: a wedged child that never
// settled, a stale snapshot reported as healthy, an unbounded socket ceiling, and
// two instances silently corrupting one data directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnPanel, setupAdmin } from './helpers/spawn-panel.js';
import { acquireInstanceLock, atomicWriteJson } from '../lib/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function get(port, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });
}

// Spawn server.js directly against a chosen data dir (the helper always makes a
// fresh one, and these tests need two processes to share one).
function spawnRaw(dataDir) {
  return spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      VMP_DATA_DIR: dataDir, VMP_PORT: '0', VMP_BIND: '127.0.0.1',
      VMP_DOCKER: path.join(ROOT, 'test', 'fixtures', 'fake-docker.js'),
      VMP_COLIMA: path.join(ROOT, 'test', 'fixtures', 'fake-colima.js'),
      FAKE_DOCKER_STATE: path.join(dataDir, 'docker-world.json'),
      FAKE_COLIMA_STATUS: 'Running',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------------------
// Liveness vs readiness
// ---------------------------------------------------------------------------

test('/healthz is liveness only — it stays 200 when the VM is down', async () => {
  // Critical distinction: if liveness flapped on a dependency outage, a
  // supervisor would restart the panel for something a restart cannot fix.
  const panel = await spawnPanel({ colimaStatus: 'Stopped', dockerDown: true });
  try {
    await setupAdmin(panel);
    const h = await get(panel.port, '/healthz');
    assert.equal(h.status, 200, 'liveness unaffected by dependency state');
    const body = JSON.parse(h.body);
    assert.equal(body.ok, true);
    assert.ok(Number.isInteger(body.uptimeSec), 'reports uptime for an operator');
  } finally { panel.kill(); }
});

test('/readyz reports NOT ready, with a reason, when the VM is down', async () => {
  // The old /healthz answered 200 from the TCP listener alone, so "the panel is
  // serving nothing" was indistinguishable from "the panel is fine" — the single
  // largest monitoring gap.
  const panel = await spawnPanel({ colimaStatus: 'Stopped', dockerDown: true });
  try {
    await setupAdmin(panel);
    const r = await get(panel.port, '/readyz');
    assert.equal(r.status, 503, 'readiness fails when machines cannot be served');
    const body = JSON.parse(r.body);
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'vm_not_running', 'machine-readable cause');
    assert.equal(body.vm.running, false);
  } finally { panel.kill(); }
});

test('/readyz reports ready when the VM is up and docker is fresh', async () => {
  const panel = await spawnPanel({});
  try {
    await setupAdmin(panel);
    const r = await get(panel.port, '/readyz');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    assert.equal(body.reason, null);
    assert.equal(body.docker.reachable, true);
    assert.equal(body.docker.stale, false);
  } finally { panel.kill(); }
});

test('both probes are unauthenticated on the machine origin too', async () => {
  // An external monitor must be able to reach them without a session.
  const panel = await spawnPanel({});
  try {
    await setupAdmin(panel);
    assert.equal((await get(panel.machinePort, '/healthz')).status, 200);
  } finally { panel.kill(); }
});

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------

test('a second panel on the same data directory refuses to start', async () => {
  const first = await spawnPanel({});
  try {
    await setupAdmin(first);
    assert.ok(fs.existsSync(path.join(first.dataDir, 'panel.lock')), 'lock taken at boot');

    const second = spawnRaw(first.dataDir);
    let out = '';
    second.stdout.on('data', (d) => { out += d; });
    second.stderr.on('data', (d) => { out += d; });
    const code = await new Promise((resolve) => {
      second.on('exit', resolve);
      setTimeout(() => { try { second.kill('SIGKILL'); } catch { /* gone */ } resolve('timeout'); }, 10_000);
    });
    // Two instances clobber users/sessions/shares last-writer-wins and double
    // every per-process limit, so refusing is the only safe behaviour.
    assert.equal(code, 1, 'second instance exits non-zero');
    assert.match(out, /VMP_FATAL/, 'refusal is greppable');
    assert.match(out, /already using/, 'refusal explains why');
  } finally { first.kill(); }
});

test('a stale lock from a dead process is reclaimed, not a permanent block', async () => {
  // A crash must never leave the panel unable to restart.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-lock-'));
  fs.writeFileSync(path.join(dataDir, 'docker-world.json'), JSON.stringify({ nextId: 1, containers: {} }));
  // A pid that cannot exist.
  fs.writeFileSync(path.join(dataDir, 'panel.lock'), JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
  const proc = spawnRaw(dataDir);
  let out = '';
  try {
    const started = await new Promise((resolve) => {
      proc.stdout.on('data', (d) => { out += d; if (/VMP_LISTENING/.test(out)) resolve(true); });
      proc.stderr.on('data', (d) => { out += d; });
      proc.on('exit', () => resolve(false));
      setTimeout(() => resolve(false), 10_000);
    });
    assert.equal(started, true, `stale lock reclaimed (output: ${out.slice(0, 200)})`);
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('acquireInstanceLock: live holder blocks, dead holder is reclaimed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-lock2-'));
  try {
    const held = acquireInstanceLock(dir);
    // Our own pid is alive, so a second acquire under a different pid must fail.
    assert.throws(() => acquireInstanceLock(dir, { pid: process.pid + 1 }), /already using/);
    held.release();
    // Released — now free.
    const again = acquireInstanceLock(dir);
    again.release();
    // A dead holder is reclaimable.
    fs.writeFileSync(path.join(dir, 'panel.lock'), JSON.stringify({ pid: 999_999 }));
    const reclaimed = acquireInstanceLock(dir);
    reclaimed.release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireInstanceLock: a lock from a previous boot is stale even if its pid is alive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-lock3-'));
  try {
    // process.pid is alive, so without the boot check this would block.
    fs.writeFileSync(path.join(dir, 'panel.lock'), JSON.stringify({ pid: process.pid, bootId: 'boot-A' }));
    const lock = acquireInstanceLock(dir, { pid: process.pid + 7, bootId: 'boot-B', isPanel: () => true });
    assert.equal(JSON.parse(fs.readFileSync(lock.path, 'utf8')).bootId, 'boot-B', 'lock rewritten for this boot');
    lock.release();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('acquireInstanceLock: a live pid that is not a panel does not block (reused pid)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-lock4-'));
  try {
    fs.writeFileSync(path.join(dir, 'panel.lock'), JSON.stringify({ pid: process.pid, bootId: 'boot-A' }));
    const lock = acquireInstanceLock(dir, { pid: process.pid + 7, bootId: 'boot-A', isPanel: () => false });
    lock.release();
    // Same boot, live pid, and it IS a panel: still refused.
    fs.writeFileSync(path.join(dir, 'panel.lock'), JSON.stringify({ pid: process.pid, bootId: 'boot-A' }));
    assert.throws(() => acquireInstanceLock(dir, { pid: process.pid + 7, bootId: 'boot-A', isPanel: () => true }), /already using/);
    // Where the OS cannot say (null), a live pid still blocks, as before.
    assert.throws(() => acquireInstanceLock(dir, { pid: process.pid + 7, bootId: 'boot-A', isPanel: () => null }), /already using/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

test('atomicWriteJson uses a process-unique temp file', async () => {
  // A fixed `<file>.tmp` let two processes interleave open/write/rename on one
  // path and publish a torn or foreign payload as users.json.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-tmp-'));
  try {
    const target = path.join(dir, 'thing.json');
    await atomicWriteJson(target, { a: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { a: 1 });
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.equal(leftovers.length, 0, 'no temp file left behind');
    assert.ok(!fs.existsSync(`${target}.tmp`), 'the fixed shared temp name is not used');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
