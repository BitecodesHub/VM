import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, loadJsonFile } from '../lib/store.js';
import { UserStore } from '../lib/users.js';
import { ShareStore } from '../lib/shares.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-store-')); }

test('atomicWriteJson: round-trips, mode 0600, no leftover tmp', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.json');
  await atomicWriteJson(file, { a: 1, b: ['two'] });
  assert.deepEqual(loadJsonFile(file, null), { a: 1, b: ['two'] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'file is 0600');
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'temp file renamed away (crash-safe)');
});

test('atomicWriteJson: concurrent writes to one path serialize (last wins, never interleave)', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'race.json');
  await Promise.all([
    atomicWriteJson(file, { n: 1 }),
    atomicWriteJson(file, { n: 2 }),
    atomicWriteJson(file, { n: 3 }),
  ]);
  const out = loadJsonFile(file, null);
  // Whatever the order, the file must be exactly ONE of the writes (valid JSON,
  // not a torn mix) — the per-path queue guarantees no interleave.
  assert.ok([1, 2, 3].includes(out.n), 'file holds one complete write');
});

test('UserStore: persist failure rolls the in-memory change back', async () => {
  const dir = tmpDir();
  const store = new UserStore(path.join(dir, 'users.json')).load();
  await store.create({ username: 'alice', password: 'pw-abcdefghij', role: 'user' });
  // Force the next write to fail; the role change must not stick in memory.
  store._persist = async () => { throw new Error('disk full'); };
  await assert.rejects(store.setRole('alice', 'admin'), /disk full/);
  assert.equal(store.get('alice').role, 'user', 'role rolled back after failed persist');
});

test('ShareStore: persist failure rolls the map back', async () => {
  const dir = tmpDir();
  const store = new ShareStore(path.join(dir, 'machines.json')).load();
  await store.grant('desktop-1', 'bob');
  store._persist = async () => { throw new Error('disk full'); };
  await assert.rejects(store.grant('desktop-1', 'carol'), /disk full/);
  assert.deepEqual(store.listFor('desktop-1'), ['bob'], 'grant rolled back — carol not added');
});
