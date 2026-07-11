import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSizeToBytes, parseDockerStats, parseSystemDf, parsePsSizes,
  shapeMachineStats, buildResourcesPayload,
} from '../lib/stats.js';

test('parseSizeToBytes: binary vs decimal units', () => {
  assert.equal(parseSizeToBytes('0B'), 0);
  assert.equal(parseSizeToBytes('104kB'), 104000);
  assert.equal(parseSizeToBytes('29.12GB'), 29120000000);
  assert.equal(parseSizeToBytes('950.1MB'), 950100000);
  assert.equal(parseSizeToBytes('1MiB'), 1048576);
  assert.equal(parseSizeToBytes('5.773GiB'), Math.round(5.773 * 1024 ** 3));
  assert.equal(parseSizeToBytes('garbage'), null);
  assert.equal(parseSizeToBytes(''), null);
  assert.equal(parseSizeToBytes(null), null);
});

const STATS_FIXTURE = [
  '{"Name":"desktop-4","CPUPerc":"5.21%","MemUsage":"919.3MiB / 5.773GiB","MemPerc":"15.55%","PIDs":"284"}',
  '{"Name":"chrome-node-1","CPUPerc":"0.46%","MemUsage":"230.5MiB / 2GiB","MemPerc":"11.2%","PIDs":"120"}',
  'garbage-line-skip',
  '',
].join('\n');

test('parseDockerStats: per-name + memLimit is the MAX (VM cgroup)', () => {
  const { byName, memLimitBytes } = parseDockerStats(STATS_FIXTURE);
  assert.equal(byName.size, 2);
  assert.equal(byName.get('desktop-4').cpuPerc, 5.21);
  assert.equal(byName.get('desktop-4').memUsedBytes, Math.round(919.3 * 1024 ** 2));
  assert.equal(byName.get('chrome-node-1').pids, 120);
  // desktop-4 uncapped (5.773GiB) > chrome cap (2GiB) → max is the VM limit
  assert.equal(memLimitBytes, Math.round(5.773 * 1024 ** 3));
  assert.equal(parseDockerStats('').byName.size, 0);
});

test('parseSystemDf: four types + total', () => {
  const df = parseSystemDf([
    '{"Type":"Images","Size":"29.12GB"}',
    '{"Type":"Containers","Size":"1.244GB"}',
    '{"Type":"Local Volumes","Size":"950.1MB"}',
    '{"Type":"Build Cache","Size":"10.71GB"}',
  ].join('\n'));
  assert.equal(df.imagesBytes, 29120000000);
  assert.equal(df.volumesBytes, 950100000);
  assert.equal(df.totalBytes, 29120000000 + 1244000000 + 950100000 + 10710000000);
});

test('parsePsSizes: writable + virtual', () => {
  const m = parsePsSizes('{"Names":"desktop-4","Size":"157MB (virtual 1.71GB)"}\n{"Names":"x","Size":"0B"}');
  assert.deepEqual(m.get('desktop-4'), { sizeRwBytes: 157000000, virtualBytes: 1710000000 });
  assert.equal(m.get('x').sizeRwBytes, 0);
});

test('shapeMachineStats: null card → null; stopped passes exitCode', () => {
  assert.equal(shapeMachineStats({ card: null }), null);
  const s = shapeMachineStats({ card: { name: 'd2', state: 'stopped', exitCode: 137 }, statsEntry: null, sizeEntry: null, sampledAt: 't', stale: false });
  assert.equal(s.exitCode, 137);
  assert.equal(s.cpuPerc, null);
});

test('buildResourcesPayload: role filtering leaks no other usernames', () => {
  const cards = [
    { name: 'd1', owner: 'alice', state: 'running', managed: true, template: 'linux-desktop' },
    { name: 'd2', owner: 'bob', state: 'running', managed: true, template: 'linux-desktop' },
    { name: 'portainer', owner: null, state: 'running', managed: false, template: 'portainer' },
  ];
  const stats = parseDockerStats([
    '{"Name":"d1","CPUPerc":"1%","MemUsage":"100MiB / 1.5GiB","MemPerc":"6%","PIDs":"10"}',
    '{"Name":"d2","CPUPerc":"2%","MemUsage":"200MiB / 1.5GiB","MemPerc":"12%","PIDs":"20"}',
    '{"Name":"portainer","CPUPerc":"0.1%","MemUsage":"50MiB / 5.773GiB","MemPerc":"1%","PIDs":"5"}',
  ].join('\n'));
  const vm = { running: true, cpu: 4, memoryBytes: 6442450944, diskBytes: 64424509440 };
  const df = parseSystemDf('{"Type":"Images","Size":"1GB"}');

  const admin = buildResourcesPayload({ user: { username: 'root', role: 'admin' }, cards, stats, df, sizes: new Map(), vm, dockerReachable: true });
  assert.equal(admin.machines.length, 2); // panel machines only (portainer excluded)
  assert.ok(admin.machines.every((m) => 'owner' in m));

  const alice = buildResourcesPayload({ user: { username: 'alice', role: 'user' }, cards, stats, df, sizes: new Map(), vm, dockerReachable: true });
  assert.deepEqual(alice.machines.map((m) => m.name), ['d1']);
  assert.ok(alice.machines.every((m) => !('owner' in m)), 'no owner key for non-admin');
  assert.ok(!JSON.stringify(alice).includes('bob'), 'no other username anywhere in user payload');
  // aggregate totals identical across roles (honest free capacity)
  assert.equal(alice.used.memBytes, admin.used.memBytes);
  assert.equal(alice.capacity.memBytes, admin.capacity.memBytes);
});

test('buildResourcesPayload: capacity source docker vs colima fallback', () => {
  const vm = { running: true, cpu: 4, memoryBytes: 6442450944 };
  const withStats = buildResourcesPayload({ user: { role: 'admin' }, cards: [], stats: parseDockerStats('{"Name":"d1","CPUPerc":"1%","MemUsage":"100MiB / 5.773GiB","MemPerc":"2%","PIDs":"1"}'), df: null, sizes: new Map(), vm, dockerReachable: true });
  assert.equal(withStats.capacity.memSource, 'docker');
  const noStats = buildResourcesPayload({ user: { role: 'admin' }, cards: [], stats: { byName: new Map(), memLimitBytes: null }, df: null, sizes: new Map(), vm, dockerReachable: true });
  assert.equal(noStats.capacity.memSource, 'colima');
  assert.equal(noStats.capacity.memBytes, 6442450944);
});
