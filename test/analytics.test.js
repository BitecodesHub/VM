import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseSessions } from '../lib/analytics.js';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const day = 86_400_000;
function row(user, machine, startISO, endISO, extra = {}) {
  const s = Date.parse(startISO), e = Date.parse(endISO);
  return { user, machine, startedAt: startISO, endedAt: endISO, durationSec: Math.round((e - s) / 1000), endedReason: 'disconnect', ...extra };
}

test('totals, per-user/machine breakdowns, and sorting', () => {
  const closed = [
    row('alice', 'm1', '2026-07-23T10:00:00Z', '2026-07-23T11:00:00Z', { template: 'linux-desktop', owner: 'bob' }),
    row('alice', 'm1', '2026-07-23T11:30:00Z', '2026-07-23T11:45:00Z', { template: 'linux-desktop', owner: 'bob' }),
    row('bob', 'm2', '2026-07-23T09:00:00Z', '2026-07-23T09:30:00Z', { template: 'chrome-node', owner: 'bob' }),
  ];
  const d = summariseSessions(closed, [], { now: NOW, days: 30 });
  assert.equal(d.totals.sessions, 3);
  assert.equal(d.totals.hours, 1.75);          // (3600+900+1800)/3600
  assert.equal(d.totals.users, 2);
  assert.equal(d.totals.machines, 2);
  assert.equal(d.totals.avgSessionSec, 2100);  // round(6300/3)
  assert.equal(d.byUser[0].user, 'alice');      // sorted by seconds desc
  assert.equal(d.byUser[0].seconds, 4500);
  assert.equal(d.byUser[0].machines, 1);
  assert.equal(d.byMachine[0].machine, 'm1');
  assert.equal(d.byMachine[0].users, 1);
  assert.equal(d.byMachine[0].owner, 'bob');
  const am1 = d.byUserMachine.find((x) => x.user === 'alice' && x.machine === 'm1');
  assert.equal(am1.seconds, 4500);
  assert.equal(am1.sessions, 2);
});

test('windows out rows older than the range', () => {
  const closed = [
    row('alice', 'm1', '2026-07-23T10:00:00Z', '2026-07-23T10:30:00Z'),
    row('old', 'm9', new Date(NOW - 60 * day).toISOString(), new Date(NOW - 60 * day + 3600_000).toISOString()),
  ];
  const d = summariseSessions(closed, [], { now: NOW, days: 30 });
  assert.equal(d.totals.sessions, 1, 'the 60-day-old session is excluded');
  assert.ok(!d.byUser.find((u) => u.user === 'old'));
});

test('daily series is zero-filled, oldest-first, length = days', () => {
  const closed = [row('alice', 'm1', '2026-07-23T10:00:00Z', '2026-07-23T11:00:00Z')];
  const d = summariseSessions(closed, [], { now: NOW, days: 7 });
  assert.equal(d.daily.length, 7);
  assert.equal(d.daily[6].date, '2026-07-23');          // today is last
  assert.equal(d.daily[6].hours, 1);
  assert.equal(d.daily[0].hours, 0);                     // 6 days ago: nothing
});

test('peak concurrency counts overlapping intervals, not clean handoffs', () => {
  const overlap = [
    row('a', 'm1', '2026-07-23T10:00:00Z', '2026-07-23T10:30:00Z'),
    row('b', 'm2', '2026-07-23T10:15:00Z', '2026-07-23T10:45:00Z'), // overlaps a
  ];
  assert.equal(summariseSessions(overlap, [], { now: NOW, days: 1 }).totals.peakConcurrency, 2);

  const handoff = [
    row('a', 'm1', '2026-07-23T10:00:00Z', '2026-07-23T10:30:00Z'),
    row('b', 'm1', '2026-07-23T10:30:00Z', '2026-07-23T11:00:00Z'), // starts exactly when a ends
  ];
  assert.equal(summariseSessions(handoff, [], { now: NOW, days: 1 }).totals.peakConcurrency, 1);
});

test('peak concurrency includes live sessions overlapping closed ones', () => {
  const closed = [row('a', 'm1', '2026-07-23T11:00:00Z', '2026-07-23T11:59:00Z')]
  const live = [{ user: 'b', machine: 'm2', startedAt: '2026-07-23T11:30:00Z', durationSec: 1800 }]
  // closed(a) 11:00–11:59 overlaps live(b) 11:30→now → 2 concurrent, even though live.length is 1.
  assert.equal(summariseSessions(closed, live, { now: NOW, days: 1 }).totals.peakConcurrency, 2)
})

test('active list never leaks client IP', () => {
  const live = [{ user: 'a', machine: 'm1', template: 't', startedAt: '2026-07-23T11:59:00Z', durationSec: 60, ip: '203.0.113.9' }]
  const d = summariseSessions([], live, { now: NOW, days: 1 })
  assert.equal(d.active.length, 1)
  assert.ok(!('ip' in d.active[0]), 'ip must be stripped from the analytics DTO')
})

test('live sessions drive active-now and floor peak concurrency', () => {
  const live = [
    { user: 'alice', machine: 'm1', durationSec: 120 },
    { user: 'alice', machine: 'm2', durationSec: 30 },
    { user: 'bob', machine: 'm3', durationSec: 5 },
  ];
  const d = summariseSessions([], live, { now: NOW, days: 30 });
  assert.equal(d.totals.activeNow, 3);
  assert.equal(d.totals.activeUsers, 2);
  assert.equal(d.totals.peakConcurrency, 3);
  assert.equal(d.active.length, 3);
});
