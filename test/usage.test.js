import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageStore } from '../lib/usage.js';

function tmp() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-usage-')), 'usage.json'); }

test('UsageStore accumulates machine-minutes per owner + template', () => {
  const u = new UsageStore(tmp());
  u.add('alice', 'linux-desktop', 1);
  u.add('alice', 'linux-desktop', 1);
  u.add('alice', 'chrome-node', 3);
  u.add('bob', 'icewm-desktop', 30);
  const s = u.summary();
  assert.equal(s[0].owner, 'bob', 'sorted by minutes desc');
  assert.equal(s[0].minutes, 30);
  assert.equal(s[0].hours, 0.5);
  const alice = s.find((x) => x.owner === 'alice');
  assert.equal(alice.minutes, 5);
  assert.equal(alice.byTemplate['linux-desktop'], 2);
  assert.equal(alice.byTemplate['chrome-node'], 3);
});

test('UsageStore persists and reloads', async () => {
  const f = tmp();
  const u = new UsageStore(f);
  u.add('carol', 'linux-desktop', 7);
  await u.flush();
  const reloaded = new UsageStore(f).load();
  assert.equal(reloaded.summary()[0].minutes, 7);
});

test('UsageStore ignores empty owner', () => {
  const u = new UsageStore(tmp());
  u.add('', 'linux-desktop', 5);
  u.add(null, 'linux-desktop', 5);
  assert.equal(u.summary().length, 0);
});
