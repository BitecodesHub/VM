import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../lib/audit.js';

function tmp() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-audit-')), 'audit.jsonl'); }

test('AuditLog: records newest-first, carries fields, ignores no-action', () => {
  let t = 1_000_000;
  const log = new AuditLog(tmp(), { now: () => t });
  log.record({ actor: 'admin', action: 'user.create', target: 'bob', detail: { role: 'user' }, ip: '10.0.0.1' });
  t += 1000;
  log.record({ actor: 'admin', action: 'machine.delete', target: 'desktop-1' });
  const entries = log.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].action, 'machine.delete', 'newest first');
  assert.equal(entries[1].actor, 'admin');
  assert.deepEqual(entries[1].detail, { role: 'user' });
  assert.equal(entries[1].ip, '10.0.0.1');
  assert.ok(entries[1].ts, 'timestamped');
});

test('AuditLog: an entry with no action is dropped', () => {
  const log = new AuditLog(tmp());
  log.record({ actor: 'x' });
  assert.equal(log.list().length, 0);
});

test('AuditLog: trims to the newest maxEntries', () => {
  const log = new AuditLog(tmp(), { maxEntries: 10, trimEvery: 5 });
  for (let i = 0; i < 40; i++) log.record({ actor: 'a', action: 'login.success', target: `n${i}` });
  const entries = log.list({ limit: 1000 });
  assert.ok(entries.length <= 10, `bounded to maxEntries, got ${entries.length}`);
  assert.equal(entries[0].target, 'n39', 'keeps the newest');
});

test('AuditLog: list tolerates a corrupt line and a missing file', () => {
  const p = tmp();
  fs.writeFileSync(p, '{"ts":"x","action":"a"}\nCORRUPT NOT JSON\n{"ts":"y","action":"b"}\n');
  const log = new AuditLog(p);
  const entries = log.list();
  assert.equal(entries.length, 2, 'corrupt line skipped');
  assert.deepEqual(new AuditLog('/no/such/dir/audit.jsonl').list(), [], 'missing file → empty');
});
