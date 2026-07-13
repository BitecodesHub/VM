import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MachineMetaStore } from '../lib/machineMeta.js';

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'vmp-meta-'));
  const store = new MachineMetaStore(path.join(dir, 'machine-meta.json')).load();
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('machineMeta: set / get / clear display name', async () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(store.displayName('desktop-1'), null, 'unset -> null');
    const stored = await store.setDisplayName('desktop-1', '  Reception PC  ');
    assert.equal(stored, 'Reception PC', 'trimmed');
    assert.equal(store.displayName('desktop-1'), 'Reception PC');
    assert.equal(await store.setDisplayName('desktop-1', ''), null, 'empty clears');
    assert.equal(store.displayName('desktop-1'), null);
  } finally { cleanup(); }
});

test('machineMeta: strips control chars, keeps spaces/hyphens, caps at 64', async () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(await store.setDisplayName('m', 'A\x01B\x1fC\x7fD'), 'ABCD', 'control chars removed');
    assert.equal(await store.setDisplayName('m', 'My-Cool Desktop'), 'My-Cool Desktop', 'spaces + hyphens kept');
    assert.equal((await store.setDisplayName('m', 'x'.repeat(100))).length, 64, 'capped at 64');
  } finally { cleanup(); }
});

test('machineMeta: persists across reload', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vmp-meta-'));
  try {
    const p = path.join(dir, 'machine-meta.json');
    await new MachineMetaStore(p).load().setDisplayName('d', 'Kept');
    assert.equal(new MachineMetaStore(p).load().displayName('d'), 'Kept', 'survives reload');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('machineMeta: removeMachine + sweep drop stale entries', async () => {
  const { store, cleanup } = freshStore();
  try {
    await store.setDisplayName('a', 'Alpha');
    await store.setDisplayName('b', 'Bravo');
    await store.removeMachine('a');
    assert.equal(store.displayName('a'), null);
    await store.sweep(new Set(['nonexistent']));
    assert.equal(store.displayName('b'), null, 'sweep removed the non-live entry');
  } finally { cleanup(); }
});
