import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShareStore } from '../lib/shares.js';

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-shares-'));
  return { store: new ShareStore(path.join(dir, 'machines.json')).load(), dir };
}

test('missing file → empty; grant/revoke persist and reload', async () => {
  const { store } = tmp();
  assert.deepEqual(store.listFor('d1'), []);
  await store.grant('d1', 'alice');
  await store.grant('d1', 'bob');
  await store.grant('d1', 'alice'); // idempotent
  assert.deepEqual(store.listFor('d1'), ['alice', 'bob']);
  const reloaded = new ShareStore(store.filePath).load();
  assert.deepEqual(reloaded.listFor('d1'), ['alice', 'bob']);
  await store.revoke('d1', 'alice');
  assert.deepEqual(store.listFor('d1'), ['bob']);
});

test('revoking the last user deletes the key', async () => {
  const { store } = tmp();
  await store.grant('d1', 'alice');
  await store.revoke('d1', 'alice');
  const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.ok(!('d1' in raw.machines), 'empty entry removed');
});

test('sharedWithUser and isSharedWith', async () => {
  const { store } = tmp();
  await store.grant('d1', 'alice');
  await store.grant('d2', 'alice');
  await store.grant('d2', 'bob');
  assert.deepEqual([...store.sharedWithUser('alice')].sort(), ['d1', 'd2']);
  assert.deepEqual([...store.sharedWithUser('bob')], ['d2']);
  assert.equal(store.isSharedWith('d2', 'bob'), true);
  assert.equal(store.isSharedWith('d1', 'bob'), false);
});

test('setList replaces, dedupes, empties', async () => {
  const { store } = tmp();
  assert.deepEqual(await store.setList('d1', ['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(store.listFor('d1'), ['a', 'b']);
  await store.setList('d1', []);
  assert.deepEqual(store.listFor('d1'), []);
  const raw = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  assert.ok(!('d1' in raw.machines));
});

test('removeMachine and removeUser scrub', async () => {
  const { store } = tmp();
  await store.grant('d1', 'alice');
  await store.grant('d2', 'alice');
  await store.grant('d2', 'bob');
  await store.removeMachine('d1');
  assert.deepEqual(store.listFor('d1'), []);
  await store.removeUser('alice');
  assert.deepEqual(store.listFor('d2'), ['bob']);
});

test('sweep drops entries for dead machines only', async () => {
  const { store } = tmp();
  await store.grant('d1', 'alice');
  await store.grant('d2', 'bob');
  await store.sweep(new Set(['d2', 'd3']));
  assert.deepEqual(store.listFor('d1'), []);
  assert.deepEqual(store.listFor('d2'), ['bob']);
});

test('malformed file throws on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-shares-'));
  const file = path.join(dir, 'machines.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => new ShareStore(file).load(), /Corrupt JSON|Malformed/);
});

test('file mode is 0600', async () => {
  const { store } = tmp();
  await store.grant('d1', 'alice');
  assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
});
