import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepStale } from '../lib/tmpsweep.js';

test('sweepStale: removes old prefixed files, keeps fresh ones and other prefixes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-sweep-'));
  try {
    const now = Date.now();
    const old = path.join(dir, 'vmp-up-old');
    const fresh = path.join(dir, 'vmp-up-fresh');
    const other = path.join(dir, 'keep-me');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(fresh, 'x');
    fs.writeFileSync(other, 'x');
    // Backdate the "old" file two hours.
    const twoHoursAgo = (now - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);

    const removed = sweepStale(dir, 'vmp-', 60 * 60 * 1000, now);
    assert.deepEqual(removed, ['vmp-up-old']);
    assert.equal(fs.existsSync(old), false, 'stale prefixed file removed');
    assert.equal(fs.existsSync(fresh), true, 'fresh file kept');
    assert.equal(fs.existsSync(other), true, 'non-prefixed file untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepStale: missing directory is a no-op (never throws)', () => {
  assert.deepEqual(sweepStale('/no/such/dir/vmp', 'vmp-', 1000), []);
});
