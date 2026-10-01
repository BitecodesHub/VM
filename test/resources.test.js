// Desktop resources (vCPU + memory limits): bounds and validation, the run args,
// the limits a card reports, and the ext API for defaults, create, live edit
// (with the in-use memory guard) and archive + restore keeping the limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resourceBounds, validateResources, parseMemoryMiB, templateDefaultResources, buildRunArgs, mapContainerToCard,
} from '../lib/core.js';
import { isStaticAsset, contentEtag, etagMatches } from '../lib/proxy.js';
import { spawnPanel, setupAdmin } from './helpers/spawn-panel.js';

const TOKEN = 'prism-ext-token-abcdefghijklmnop';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { let v; try { v = fn(); } catch { v = null; } if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)); } };

test('resource bounds: all host CPUs, host memory minus 1 GiB, in steps', () => {
  const b = resourceBounds(2, 7802);
  assert.deepEqual(b.max, { cpus: 2, memoryMiB: 6656 });
  assert.deepEqual(b.min, { cpus: 0.5, memoryMiB: 1024 });
  assert.deepEqual(resourceBounds(1, 1500).max, { cpus: 1, memoryMiB: 1024 }, 'a tiny host still allows the minimum');
});

test('resource validation: steps and bounds', () => {
  const b = resourceBounds(2, 7802);
  assert.deepEqual(validateResources({ cpus: 1.5, memoryMiB: 3072 }, b), { ok: true, value: { cpus: 1.5, memoryMiB: 3072 } });
  assert.deepEqual(validateResources({ cpus: '1', memoryMiB: '2048' }, b).value, { cpus: 1, memoryMiB: 2048 }, 'numeric strings');
  for (const bad of [{ cpus: 0.25, memoryMiB: 2048 }, { cpus: 1.3, memoryMiB: 2048 }, { cpus: 4, memoryMiB: 2048 }, { cpus: 1, memoryMiB: 512 },
    { cpus: 1, memoryMiB: 3000 }, { cpus: 1, memoryMiB: 8192 }, { cpus: NaN, memoryMiB: 2048 }, null, [], 'x']) {
    assert.equal(validateResources(bad, b).ok, false, JSON.stringify(bad));
  }
});

test('templates: default resources; memory strings parse', () => {
  assert.deepEqual(templateDefaultResources('linux-desktop'), { cpus: 2, memoryMiB: 2048 });
  assert.deepEqual(templateDefaultResources('icewm-desktop'), { cpus: 2, memoryMiB: 1536 });
  assert.equal(templateDefaultResources('nope'), null);
  assert.equal(parseMemoryMiB('2g'), 2048); assert.equal(parseMemoryMiB('1536m'), 1536); assert.equal(parseMemoryMiB('x'), null);
});

test('run args: given resources replace the template values; memory-swap equals memory', () => {
  const base = { template: 'linux-desktop', name: 'd1', owner: 'alice', ports: { ui: 6901, audio: 4901, mic: 4801 }, createdAt: 'x', cap: true };
  const a = buildRunArgs({ ...base, resources: { cpus: 1.5, memoryMiB: 3072 } });
  assert.equal(a[a.indexOf('--memory') + 1], '3072m');
  assert.equal(a[a.indexOf('--memory-swap') + 1], '3072m');
  assert.equal(a[a.indexOf('--cpus') + 1], '1.5');
  const d = buildRunArgs(base);
  assert.equal(d[d.indexOf('--memory') + 1], '2048m', 'template default');
  const u = buildRunArgs({ ...base, cap: false, resources: { cpus: 1, memoryMiB: 2048 } });
  assert.ok(!u.includes('--memory') && !u.includes('--cpus'), 'uncapped: no limits at all');
});

test('card: reports the limits Docker enforces now', () => {
  const card = mapContainerToCard({ Name: '/d1', Image: 'sha256:abc', Config: { Image: 'x', Labels: { 'vmpanel.managed': '1', 'vmpanel.template': 'linux-desktop', 'vmpanel.owner': 'a' } }, State: { Status: 'running' }, HostConfig: { PortBindings: {}, Memory: 3221225472, NanoCpus: 1500000000 } });
  assert.deepEqual(card.limits, { cpus: 1.5, memoryMiB: 3072 });
  assert.equal(card.capped, true);
  assert.equal(card.imageId, 'sha256:abc');
  const open = mapContainerToCard({ Name: '/d2', Config: { Labels: { 'vmpanel.managed': '1', 'vmpanel.template': 'linux-desktop' } }, State: { Status: 'running' }, HostConfig: {} });
  assert.deepEqual(open.limits, { cpus: null, memoryMiB: null });
});

test('static assets: which files are revalidated by content, and the tag is the content hash', () => {
  for (const p of ['/main.bundle.js', '/assets/webutil-DUkojxeL.js?v=1', '/assets/x.css', '/jsmpeg.min.js', '/assets/splash-D03O8R4K.jpg', '/assets/Orbitron700-DI3tXiXq.woff']) assert.ok(isStaticAsset(p), p);
  for (const p of ['/vnc.html', '/', '/websockify', '/kasmaudio', '/api/get_frame_stats']) assert.ok(!isStaticAsset(p), p);
  const a = contentEtag(Buffer.from('one')); const b = contentEtag(Buffer.from('two'));
  assert.match(a, /^"c-[0-9a-f]{24}"$/);
  assert.notEqual(a, b, 'different bytes, different tag');
  assert.equal(a, contentEtag(Buffer.from('one')), 'same bytes, same tag');
});

test('static assets: If-None-Match matching is tolerant of W/, lists and compression suffixes', () => {
  const tag = 'W/"abc-123"';
  for (const ok of ['W/"abc-123"', '"abc-123"', '"abc-123-zstd"', 'W/"abc-123-gzip"', '"x", W/"abc-123"', '*']) assert.ok(etagMatches(ok, tag), ok);
  for (const no of ['', null, '"abc-124"', 'W/"abc"']) assert.ok(!etagMatches(no, tag), String(no));
});

test('ext: resource defaults, create with explicit or default limits, live edit, in-use guard, restore keeps limits', async () => {
  const panel = await spawnPanel({ env: { VMP_PANEL_API_TOKEN: TOKEN } });
  try {
    await setupAdmin(panel);
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'alice' } });

    // Templates and settings expose defaults + bounds.
    const tpl = await panel.req('GET', '/api/ext/templates', { headers: AUTH });
    assert.deepEqual(tpl.json.templates.find((t) => t.id === 'linux-desktop').defaults, { cpus: 2, memoryMiB: 2048 });
    assert.ok(tpl.json.bounds.max.cpus >= 0.5 && tpl.json.bounds.max.memoryMiB >= 1024);
    let st = await panel.req('GET', '/api/ext/settings', { headers: AUTH });
    assert.deepEqual(st.json.settings.resourceDefaults['icewm-desktop'], { cpus: 2, memoryMiB: 1536 });
    assert.ok(st.json.readOnly.resourceBounds.max.memoryMiB >= 1024);

    // Change the XFCE default; bad input is refused and nothing is saved.
    assert.equal((await panel.req('PATCH', '/api/ext/settings', { headers: AUTH, body: { resourceDefaults: { 'firefox-node': { cpus: 1, memoryMiB: 2048 } } } })).status, 400, 'withdrawn template');
    assert.equal((await panel.req('PATCH', '/api/ext/settings', { headers: AUTH, body: { resourceDefaults: { 'linux-desktop': { cpus: 1, memoryMiB: 1000 } } } })).status, 400, 'off-step memory');
    st = await panel.req('PATCH', '/api/ext/settings', { headers: AUTH, body: { resourceDefaults: { 'linux-desktop': { cpus: 1, memoryMiB: 1536 } } } });
    assert.equal(st.status, 200, JSON.stringify(st.json));
    assert.deepEqual(st.json.settings.resourceDefaults['linux-desktop'], { cpus: 1, memoryMiB: 1536 });
    assert.deepEqual(st.json.settings.resourceDefaults['icewm-desktop'], { cpus: 2, memoryMiB: 1536 }, 'other templates untouched');
    assert.deepEqual(JSON.parse((await import('node:fs')).readFileSync(`${panel.dataDir}/config.json`, 'utf8')).resourceDefaults['linux-desktop'], { cpus: 1, memoryMiB: 1536 }, 'persisted');

    // Create: the saved default applies; explicit resources win.
    assert.equal((await panel.req('POST', '/api/ext/machines', { headers: AUTH, body: { owner: 'alice', template: 'linux-desktop', name: 'def-desk' } })).status, 202);
    assert.equal((await panel.req('POST', '/api/ext/machines', { headers: AUTH, body: { owner: 'alice', template: 'linux-desktop', name: 'big-desk', resources: { cpus: 1.5, memoryMiB: 3072 } } })).status, 202);
    assert.equal((await panel.req('POST', '/api/ext/machines', { headers: AUTH, body: { owner: 'alice', template: 'linux-desktop', name: 'bad-desk', resources: { cpus: 99, memoryMiB: 3072 } } })).status, 400);
    const world = await until(() => { const w = panel.readWorld(); return w.containers['def-desk'] && w.containers['big-desk'] ? w : null; });
    assert.equal(world.containers['def-desk'].memoryBytes, 1536 * 1048576);
    assert.equal(world.containers['def-desk'].nanoCpus, 1e9);
    assert.equal(world.containers['big-desk'].memoryBytes, 3072 * 1048576);
    assert.equal(world.containers['big-desk'].nanoCpus, 1.5e9);
    let list = await panel.req('GET', '/api/ext/machines', { headers: AUTH });
    assert.deepEqual(list.json.machines.find((x) => x.name === 'big-desk').limits, { cpus: 1.5, memoryMiB: 3072 });

    // Live edit.
    let r = await panel.req('PATCH', '/api/ext/machines/big-desk/resources', { headers: AUTH, body: { cpus: 2, memoryMiB: 4096, actor: 'admin1' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.limits, { cpus: 2, memoryMiB: 4096 });
    assert.equal(panel.readWorld().containers['big-desk'].memoryBytes, 4096 * 1048576);
    assert.equal(panel.readWorld().containers['big-desk'].state, 'running', 'still running');
    assert.equal((await panel.req('PATCH', '/api/ext/machines/big-desk/resources', { headers: AUTH, body: { cpus: 2, memoryMiB: 999 } })).status, 400);
    assert.equal((await panel.req('PATCH', '/api/ext/machines/ghost/resources', { headers: AUTH, body: { cpus: 1, memoryMiB: 2048 } })).status, 404);

    // Squeezing below what the desktop uses now is refused, with the minimum.
    const w2 = panel.readWorld(); w2.containers['big-desk'].memUsedMiB = 2600; panel.writeWorld(w2);
    await new Promise((res) => setTimeout(res, 5200)); // stats cache TTL
    r = await panel.req('PATCH', '/api/ext/machines/big-desk/resources', { headers: AUTH, body: { cpus: 2, memoryMiB: 2560 } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'MEMORY_IN_USE');
    assert.equal(r.json.minMemoryMiB, 3072);
    assert.equal(panel.readWorld().containers['big-desk'].memoryBytes, 4096 * 1048576, 'unchanged');

    // The audit records before/after.
    const audit = await panel.req('GET', '/api/ext/audit?limit=50', { headers: AUTH });
    const ev = audit.json.entries.find((e) => e.action === 'machine.resources');
    assert.deepEqual(ev.detail.after, { cpus: 2, memoryMiB: 4096 });
    assert.deepEqual(ev.detail.before, { cpus: 1.5, memoryMiB: 3072 });

    // Archive + restore keeps the limits.
    const del = await panel.req('DELETE', '/api/ext/machines/big-desk', { headers: AUTH, body: { confirm: 'big-desk', archive: true } });
    assert.equal(del.status, 202, JSON.stringify(del.json));
    const job = await until(async () => null, 0) || del.json.job;
    let j; for (let i = 0; i < 60; i++) { j = (await panel.req('GET', `/api/ext/jobs/${job.id}`, { headers: AUTH })).json.job; if (j.status !== 'running') break; await new Promise((res) => setTimeout(res, 150)); }
    assert.equal(j.status, 'done', JSON.stringify(j));
    assert.deepEqual(j.result.archive.limits, { cpus: 2, memoryMiB: 4096 });
    const rest = await panel.req('POST', `/api/ext/archives/${j.result.archive.id}/restore`, { headers: AUTH, body: {} });
    assert.equal(rest.status, 202, JSON.stringify(rest.json));
    for (let i = 0; i < 60; i++) { j = (await panel.req('GET', `/api/ext/jobs/${rest.json.job.id}`, { headers: AUTH })).json.job; if (j.status !== 'running') break; await new Promise((res) => setTimeout(res, 150)); }
    assert.equal(j.status, 'done', JSON.stringify(j));
    assert.equal(panel.readWorld().containers['big-desk'].memoryBytes, 4096 * 1048576, 'restored at its old size');
    assert.equal(panel.readWorld().containers['big-desk'].nanoCpus, 2e9);
  } finally { panel.kill(); }
});

test('resource validation: booleans and arrays are not numbers; restored limits are clamped, not dropped', async () => {
  const { clampResources } = await import('../lib/core.js');
  const b = resourceBounds(2, 7802);
  for (const bad of [{ cpus: true, memoryMiB: 2048 }, { cpus: [2], memoryMiB: 2048 }, { cpus: 1, memoryMiB: [2048] }, { cpus: '', memoryMiB: 2048 }]) assert.equal(validateResources(bad, b).ok, false, JSON.stringify(bad));
  assert.deepEqual(clampResources({ cpus: 8, memoryMiB: 32768 }, b), { cpus: 2, memoryMiB: 6656 });
  assert.deepEqual(clampResources({ cpus: 0.1, memoryMiB: 300 }, b), { cpus: 0.5, memoryMiB: 1024 });
  assert.deepEqual(validateResources({ cpus: 1.5000000001, memoryMiB: 2048 }, b).value, { cpus: 1.5, memoryMiB: 2048 }, 'snapped to the step');
});

test('static assets: files in the desktop user\'s Downloads share are never tagged', () => {
  assert.equal(isStaticAsset('/Downloads/report.json'), false);
  assert.equal(isStaticAsset('/Downloads/'), false);
  assert.equal(isStaticAsset('/downloads/x.png'), false);
});
