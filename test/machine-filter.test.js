import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSortMachines, SORT_OPTIONS } from '../public/js/machine-filter.js';

const M = [
  { name: 'desktop-2', templateLabel: 'Linux Desktop — Modern (XFCE)', owner: 'alice', state: 'running', statusText: 'Running', startedAt: '2026-07-10T10:00:00Z' },
  { name: 'desktop-10', templateLabel: 'Linux Desktop — Modern (XFCE)', owner: 'bob', state: 'stopped', statusText: 'Stopped', startedAt: null },
  { name: 'chrome-node-1', templateLabel: 'Chrome Node', owner: 'alice', state: 'running', statusText: 'Running', startedAt: '2026-07-10T12:00:00Z' },
];

test('filterSortMachines: text search matches name, type, owner, status', () => {
  assert.deepEqual(filterSortMachines(M, { q: 'chrome' }).map((m) => m.name), ['chrome-node-1']);
  assert.deepEqual(filterSortMachines(M, { q: 'bob' }).map((m) => m.name), ['desktop-10']);
  assert.deepEqual(filterSortMachines(M, { q: 'stopped' }).map((m) => m.name), ['desktop-10']);
  assert.equal(filterSortMachines(M, { q: 'alice' }).length, 2);
  assert.equal(filterSortMachines(M, { q: 'nomatch' }).length, 0);
});

test('filterSortMachines: name sort is numeric-aware (desktop-2 before desktop-10)', () => {
  assert.deepEqual(
    filterSortMachines(M, { sort: 'name' }).map((m) => m.name),
    ['chrome-node-1', 'desktop-2', 'desktop-10'],
  );
});

test('filterSortMachines: created sort is newest-first, unstarted last', () => {
  assert.deepEqual(
    filterSortMachines(M, { sort: 'created' }).map((m) => m.name),
    ['chrome-node-1', 'desktop-2', 'desktop-10'],
  );
});

test('filterSortMachines: does not mutate input; unknown sort falls back to name', () => {
  const copy = [...M];
  filterSortMachines(M, { sort: 'bogus' });
  assert.deepEqual(M, copy, 'input array untouched');
  assert.deepEqual(filterSortMachines(M, { sort: 'bogus' }).map((m) => m.name), ['chrome-node-1', 'desktop-2', 'desktop-10']);
  assert.ok(SORT_OPTIONS.length >= 3);
});
