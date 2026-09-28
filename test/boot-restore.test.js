import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLastRunning, lastRunningRecord, planBootRestore, LAST_RUNNING_FILE } from '../lib/bootRestore.js';
import { spawnPanel } from './helpers/spawn-panel.js';

const isPanelMachine = (c) => c.managed === true;
const card = (name, state, extra = {}) => ({ name, state, managed: true, restartPolicy: 'on-failure', ...extra });
const cards = (...list) => new Map(list.map((c) => [c.name, c]));

test('boot restore: a record from another boot restarts the stopped desktops, most recent first', () => {
  const last = { bootId: 'boot-1', names: ['b', 'a'] };
  const plan = planBootRestore(last, 'boot-2', cards(card('a', 'exited'), card('b', 'exited')), { maxRunning: 4, isPanelMachine });
  assert.deepEqual(plan, ['b', 'a']);
});

test('boot restore: the same boot (a plain panel restart) restores nothing', () => {
  const last = { bootId: 'boot-1', names: ['a'] };
  assert.deepEqual(planBootRestore(last, 'boot-1', cards(card('a', 'exited')), { maxRunning: 4, isPanelMachine }), []);
  assert.deepEqual(planBootRestore(null, 'boot-1', cards(card('a', 'exited')), { maxRunning: 4, isPanelMachine }), []);
  assert.deepEqual(planBootRestore({ bootId: null, names: ['a'] }, 'boot-2', cards(card('a', 'exited')), { maxRunning: 4, isPanelMachine }), [], 'no boot id recorded');
  assert.deepEqual(planBootRestore(last, null, cards(card('a', 'exited')), { maxRunning: 4, isPanelMachine }), [], 'boot id unreadable now');
});

test('boot restore: skips running, deleted, unmanaged and Docker-restarted machines', () => {
  const last = { bootId: 'boot-1', names: ['up', 'gone', 'foreign', 'legacy', 'ok'] };
  const plan = planBootRestore(last, 'boot-2', cards(
    card('up', 'running'),
    card('foreign', 'exited', { managed: false }),
    card('legacy', 'exited', { restartPolicy: 'unless-stopped' }),
    card('ok', 'exited'),
  ), { maxRunning: 0, isPanelMachine });
  assert.deepEqual(plan, ['ok']);
});

test('boot restore: stays within the running-machine limit', () => {
  const last = { bootId: 'boot-1', names: ['a', 'b', 'c'] };
  const plan = planBootRestore(last, 'boot-2', cards(
    card('legacy', 'running', { restartPolicy: 'unless-stopped' }),
    card('a', 'exited'), card('b', 'exited'), card('c', 'exited'),
  ), { maxRunning: 3, isPanelMachine });
  assert.deepEqual(plan, ['a', 'b'], 'one slot is already taken');
  assert.deepEqual(planBootRestore(last, 'boot-2', cards(card('a', 'running'), card('b', 'exited')), { maxRunning: 1, isPanelMachine }), []);
});

test('boot restore: the record round-trips and a corrupt file reads as none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-boot-'));
  try {
    assert.equal(readLastRunning(dir), null, 'missing file');
    const rec = lastRunningRecord('boot-9', ['x', 'y'], new Date('2026-09-28T00:00:00Z'));
    fs.writeFileSync(path.join(dir, LAST_RUNNING_FILE), JSON.stringify(rec));
    assert.deepEqual(readLastRunning(dir), { bootId: 'boot-9', at: '2026-09-28T00:00:00.000Z', names: ['x', 'y'] });
    fs.writeFileSync(path.join(dir, LAST_RUNNING_FILE), '{not json');
    assert.equal(readLastRunning(dir), null);
    fs.writeFileSync(path.join(dir, LAST_RUNNING_FILE), JSON.stringify({ bootId: 'b', names: 'x' }));
    assert.equal(readLastRunning(dir), null, 'names must be a list');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('boot restore (integration): after a reboot the panel restarts the desktops that were running', async () => {
  const desk = (id, extra = {}) => ({
    id, image: 'minimal-linux-desktop:xfce', state: 'exited', exitCode: 0,
    labels: { 'vmpanel.managed': '1', 'vmpanel.template': 'linux-desktop', 'vmpanel.owner': 'admin', 'vmpanel.ui.port': String(7000 + id.length) },
    ...extra,
  });
  const panel = await spawnPanel({
    world: { nextId: 10, containers: { 'was-on': desk('c1'), 'was-off': desk('c22'), 'legacy-on': desk('c333', { restart: 'unless-stopped' }) } },
    env: { VMP_TEST_BOOT_ID: 'boot-2', VMP_BOOT_RESTORE_DELAY_MS: '0' },
    files: { 'last-running.json': { bootId: 'boot-1', at: '2026-09-28T00:00:00Z', names: ['was-on', 'legacy-on'] } },
  });
  try {
    let world;
    for (let i = 0; i < 50; i++) {
      // fake docker rewrites the world file while it runs: a torn read is not a result.
      try { world = panel.readWorld(); } catch { world = null; }
      if (world?.containers['was-on'].state === 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    for (let i = 0; i < 20 && !world; i++) { try { world = panel.readWorld(); } catch { await new Promise((r) => setTimeout(r, 50)); } }
    assert.equal(world.containers['was-on'].state, 'running', 'restored');
    assert.equal(world.containers['was-off'].state, 'exited', 'was not running before the reboot');
    assert.equal(world.containers['legacy-on'].state, 'exited', 'left to its own Docker restart policy');
    assert.match(panel.stdout(), /\[VMP_BOOT_RESTORE\] start was-on: ok/);
  } finally { panel.kill(); }
});
