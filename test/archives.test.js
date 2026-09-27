import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchiveStore, validArchiveId } from '../lib/archives.js';

function freshStore(clock = { t: Date.parse('2026-09-27T00:00:00Z') }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-arch-'));
  const store = new ArchiveStore(path.join(dir, 'archives'), { now: () => clock.t }).load();
  return { store, clock, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function addOne(store, over = {}) {
  const id = store.newId();
  fs.writeFileSync(store.fileFor(id), 'gz-bytes');
  return store.add({ id, machine: 'desk-1', template: 'linux-desktop', owner: 'alice', sharedWith: ['bob'], homeDir: '/home/kasm-user', bytes: 8, deletedBy: 'admin@example', ...over });
}

test('archives: ids are 16 hex chars and validated strictly', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.match(store.newId(), /^[a-f0-9]{16}$/);
    assert.equal(validArchiveId('../../etc/passwd'), false);
    assert.equal(validArchiveId('ABCDEF0123456789'), false, 'uppercase rejected');
    assert.equal(validArchiveId(null), false);
  } finally { cleanup(); }
});

test('archives: the directory is private (0700)', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700);
  } finally { cleanup(); }
});

test('archives: add requires the finished file, and expires after 7 days', async () => {
  const { store, clock, cleanup } = freshStore();
  try {
    await assert.rejects(store.add({ id: store.newId(), machine: 'x', template: 'linux-desktop', homeDir: '/home/kasm-user', bytes: 1 }), /archive file missing/);
    const entry = await addOne(store);
    assert.equal(entry.expiresAt, '2026-10-04T00:00:00.000Z', 'deletedAt + 7 days');
    assert.equal(store.isExpired(entry.id), false);
    assert.deepEqual(store.list().map((e) => e.id), [entry.id]);
    assert.equal('file' in store.list()[0], false, 'no on-disk path in the public shape');
    clock.t += 7 * 86_400_000;
    assert.equal(store.isExpired(entry.id), true, 'expired exactly at the boundary');
  } finally { cleanup(); }
});

test('archives: purgeExpired removes the index entry and the file', async () => {
  const { store, clock, cleanup } = freshStore();
  try {
    const old = await addOne(store);
    clock.t += 3 * 86_400_000;
    const young = await addOne(store, { machine: 'desk-2' });
    clock.t += 5 * 86_400_000; // old is 8 days, young is 5 days
    assert.deepEqual(await store.purgeExpired(), [old.id]);
    assert.equal(fs.existsSync(store.fileFor(old.id)), false, 'file removed');
    assert.equal(fs.existsSync(store.fileFor(young.id)), true, 'unexpired copy kept');
    assert.deepEqual(store.list().map((e) => e.id), [young.id]);
  } finally { cleanup(); }
});

test('archives: the index survives a reload', async () => {
  const { store, clock, cleanup } = freshStore();
  try {
    const entry = await addOne(store);
    const again = new ArchiveStore(store.dir, { now: () => clock.t }).load();
    assert.equal(again.get(entry.id).machine, 'desk-1');
    assert.equal(again.totalBytes(), 8);
  } finally { cleanup(); }
});

test('archives: sweepOrphans drops stale partials and unindexed files, never live copies', async () => {
  // File mtimes are real wall-clock time, so the store's clock starts there too.
  const { store, clock, cleanup } = freshStore({ t: Date.now() });
  try {
    const live = await addOne(store);
    const orphanId = store.newId();
    fs.writeFileSync(store.partialFor(orphanId), 'half');
    fs.writeFileSync(store.fileFor(store.newId()), 'unindexed');
    fs.writeFileSync(path.join(store.dir, 'notes.txt'), 'not ours');
    assert.deepEqual(store.sweepOrphans(), [], 'inside the grace window nothing is touched');
    clock.t += 2 * 60 * 60 * 1000;
    const removed = store.sweepOrphans();
    assert.equal(removed.length, 2, 'the partial and the unindexed file');
    assert.equal(fs.existsSync(store.fileFor(live.id)), true, 'indexed copy kept');
    assert.equal(fs.existsSync(path.join(store.dir, 'notes.txt')), true, 'foreign files ignored');
  } finally { cleanup(); }
});
