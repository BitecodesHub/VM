import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageSessionStore } from '../lib/usage-sessions.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-usess-')); }
function make(clock) {
  const d = tmpDir();
  return new UsageSessionStore(
    path.join(d, 'usage-sessions.jsonl'),
    path.join(d, 'usage-open.json'),
    { now: () => clock.t, flushDebounceMs: 5 },
  );
}

test('ref-counts sockets: a session ends only when the LAST socket closes', () => {
  const clock = { t: 1_000_000 };
  const s = make(clock);
  // One desktop opens 3 sockets (screen + kasmaudio + kasmmic).
  s.open('alice', 'desk-1', { template: 'linux-desktop', owner: 'bob' });
  s.open('alice', 'desk-1');
  s.open('alice', 'desk-1');
  assert.equal(s.liveList().length, 1, 'still one live session after 3 opens');
  assert.equal(s.closedList().length, 0, 'nothing closed yet');
  s.close('alice', 'desk-1');
  s.close('alice', 'desk-1');
  assert.equal(s.liveList().length, 1, 'still live after 2 of 3 closes');
  clock.t += 60_000; // one minute of use
  s.close('alice', 'desk-1'); // last socket
  const closed = s.closedList();
  assert.equal(s.liveList().length, 0, 'no live sessions after last close');
  assert.equal(closed.length, 1, 'exactly one closed row for the whole session');
  assert.equal(closed[0].user, 'alice');
  assert.equal(closed[0].machine, 'desk-1');
  assert.equal(closed[0].template, 'linux-desktop');
  assert.equal(closed[0].owner, 'bob');
  assert.equal(closed[0].durationSec, 60);
  assert.equal(closed[0].endedReason, 'disconnect');
});

test('separate users and machines are tracked independently', () => {
  const clock = { t: 0 };
  const s = make(clock);
  s.open('alice', 'desk-1');
  s.open('bob', 'desk-1');   // same machine, different user
  s.open('alice', 'desk-2'); // same user, different machine
  assert.equal(s.liveList().length, 3);
  clock.t += 30_000;
  s.close('bob', 'desk-1');
  const closed = s.closedList();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].user, 'bob');
  assert.equal(s.liveList().length, 2);
});

test('ignores empty user or machine', () => {
  const clock = { t: 0 };
  const s = make(clock);
  s.open('', 'desk-1');
  s.open('alice', '');
  s.open(null, null);
  assert.equal(s.liveList().length, 0);
});

test('restart reconcile closes orphaned live sessions at last heartbeat', async () => {
  const clock = { t: 5_000_000 };
  const jsonl = path.join(tmpDir(), 's.jsonl');
  const openf = jsonl.replace('.jsonl', '.open.json');
  const s1 = new UsageSessionStore(jsonl, openf, { now: () => clock.t, flushDebounceMs: 5 });
  s1.open('carol', 'desk-9', { template: 'icewm-desktop' });
  clock.t += 120_000;
  s1.heartbeat();        // last seen at +120s
  clock.t += 3_600_000;  // panel then down for an hour
  await s1.flush();      // checkpoint written, session still "live"

  // New process boots, loads the checkpoint, reconciles.
  const s2 = new UsageSessionStore(jsonl, openf, { now: () => clock.t }).load();
  const closedCount = s2.reconcile('panel_restart');
  assert.equal(closedCount, 1);
  assert.equal(s2.liveList().length, 0);
  const closed = s2.closedList();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].endedReason, 'panel_restart');
  // Duration is the LOWER bound (up to last heartbeat, not the hour of downtime).
  assert.equal(closed[0].durationSec, 120, 'closed at heartbeat, not at boot time');
});

test('heartbeat keeps live sessions and extends elapsed duration', () => {
  const clock = { t: 0 };
  const s = make(clock);
  s.open('dave', 'desk-3');
  clock.t += 45_000;
  s.heartbeat();
  const live = s.liveList();
  assert.equal(live.length, 1);
  assert.equal(live[0].durationSec, 45);
  assert.ok(live[0].startedAt);
});

test('closedList filters by sinceMs and honours limit', () => {
  const clock = { t: 1_000_000 };
  const s = make(clock);
  // Three quick sessions at t=1s,2s,3s (each 0-length).
  for (const [u, at] of [['u1', 1_000_000], ['u2', 2_000_000], ['u3', 3_000_000]]) {
    clock.t = at; s.open(u, 'm'); s.close(u, 'm');
  }
  assert.equal(s.closedList().length, 3);
  assert.equal(s.closedList({ limit: 2 }).length, 2, 'limit caps rows');
  const recent = s.closedList({ sinceMs: 2_500_000 });
  assert.equal(recent.length, 1, 'only the newest is after the cutoff');
  assert.equal(recent[0].user, 'u3');
});

test('never records a negative duration when the clock goes backwards', () => {
  const clock = { t: 10_000 };
  const s = make(clock);
  s.open('erin', 'desk-4');
  clock.t = 5_000; // clock skew backwards
  s.close('erin', 'desk-4');
  assert.equal(s.closedList()[0].durationSec, 0);
});
