// Full machine management through the ext API (PRISM /settings/vms): archived
// delete + restore, rename, logs, files, capacity, settings, audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnPanel, setupAdmin } from './helpers/spawn-panel.js';

const TOKEN = 'prism-ext-token-abcdefghijklmnop';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

async function withPanel(fn, opts = {}) {
  const panel = await spawnPanel({ ...opts, env: { VMP_PANEL_API_TOKEN: TOKEN, ...(opts.env || {}) } });
  try { await fn(panel); } finally { panel.kill(); }
}

async function makeDesk(panel, name, owner = 'alice') {
  await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: owner } });
  const r = await panel.req('POST', '/api/ext/machines', { headers: AUTH, body: { owner, template: 'linux-desktop', name } });
  assert.equal(r.status, 202, `create ${name}: ${r.text}`);
}

async function waitJob(panel, id) {
  for (let i = 0; i < 100; i++) {
    const r = await panel.req('GET', `/api/ext/jobs/${id}`, { headers: AUTH });
    assert.equal(r.status, 200, r.text);
    if (r.json.job.status !== 'running') return r.json.job;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('job did not finish');
}

test('ext delete: keeps a restorable copy, removes the machine, and restore brings it back', async () => {
  await withPanel(async (panel) => {
    await setupAdmin(panel);
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'bob' } });
    await makeDesk(panel, 'desk-arch');
    await panel.req('PUT', '/api/ext/machines/desk-arch/access', { headers: AUTH, body: { sharedWith: ['bob'] } });
    await panel.req('PATCH', '/api/ext/machines/desk-arch/rename', { headers: AUTH, body: { displayName: 'Reception PC' } });
    const w = panel.readWorld(); w.containers['desk-arch'].homeContent = 'alice-files'; panel.writeWorld(w);

    assert.equal((await panel.req('DELETE', '/api/ext/machines/desk-arch', { headers: AUTH, body: { confirm: 'wrong' } })).status, 400, 'confirmation must match');

    const del = await panel.req('DELETE', '/api/ext/machines/desk-arch', { headers: AUTH, body: { confirm: 'desk-arch', actor: 'admin@example', ref: 'prism-ref-1' } });
    assert.equal(del.status, 202, del.text);
    const job = await waitJob(panel, del.json.job.id);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.name, 'desk-arch');

    const list = await panel.req('GET', '/api/ext/machines', { headers: AUTH });
    assert.ok(!list.json.machines.some((m) => m.name === 'desk-arch'), 'machine removed');

    const arch = await panel.req('GET', '/api/ext/archives', { headers: AUTH });
    assert.equal(arch.status, 200);
    assert.equal(arch.json.retentionDays, 7);
    const entry = arch.json.archives.find((a) => a.machine === 'desk-arch');
    assert.ok(entry, 'archive listed');
    assert.equal(entry.owner, 'alice');
    assert.equal(entry.displayName, 'Reception PC');
    assert.deepEqual(entry.sharedWith, ['bob']);
    assert.equal(entry.deletedBy, 'admin@example');
    assert.equal(entry.ref, 'prism-ref-1', 'caller reference kept');

    // The file on disk is a real gzip of what docker cp streamed, and private.
    const file = path.join(panel.dataDir, 'archives', `${entry.id}.tar.gz`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(zlib.gunzipSync(fs.readFileSync(file)).toString(), /FAKE-TAR desk-arch:\/home\/kasm-user\nalice-files/);

    const rest = await panel.req('POST', `/api/ext/archives/${entry.id}/restore`, { headers: AUTH, body: {} });
    assert.equal(rest.status, 202, rest.text);
    const rjob = await waitJob(panel, rest.json.job.id);
    assert.equal(rjob.status, 'done', JSON.stringify(rjob.error));
    assert.deepEqual({ name: rjob.result.name, owner: rjob.result.owner, ref: rjob.result.ref }, { name: 'desk-arch', owner: 'alice', ref: 'prism-ref-1' });
    assert.equal((await panel.req('DELETE', '/api/ext/machines/desk-arch', { headers: AUTH, body: { confirm: 'desk-arch', ref: 'bad ref!' } })).status, 400, 'ref validated');

    const back = (await panel.req('GET', '/api/ext/machines', { headers: AUTH })).json.machines.find((m) => m.name === 'desk-arch');
    assert.ok(back, 'machine restored');
    assert.equal(back.owner, 'alice');
    assert.equal(back.displayName, 'Reception PC', 'display name restored');
    assert.deepEqual(back.sharedWith, ['bob'], 'sharing restored');
    assert.equal(back.state, 'running');
    const restored = panel.readWorld().containers['desk-arch'].restored;
    assert.equal(restored.dest, '/home', 'extracted into the parent of the home dir');
    assert.match(restored.payload, /alice-files/, 'the archived files were copied back');
    assert.equal((await panel.req('GET', '/api/ext/archives', { headers: AUTH })).json.archives.length, 0, 'copy consumed by the restore');
    assert.equal(fs.existsSync(file), false);
  });
});

test('ext delete: a failed copy deletes nothing and restarts the desktop', async () => {
  await withPanel(async (panel) => {
    await setupAdmin(panel);
    await makeDesk(panel, 'desk-keep');
    const del = await panel.req('DELETE', '/api/ext/machines/desk-keep', { headers: AUTH, body: { confirm: 'desk-keep' } });
    const job = await waitJob(panel, del.json.job.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'ARCHIVE_FAILED');
    const m = (await panel.req('GET', '/api/ext/machines', { headers: AUTH })).json.machines.find((x) => x.name === 'desk-keep');
    assert.ok(m, 'machine still exists');
    assert.equal(m.state, 'running', 'restarted after the failed copy');
    assert.equal((await panel.req('GET', '/api/ext/archives', { headers: AUTH })).json.archives.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(panel.dataDir, 'archives')).filter((f) => f.endsWith('.partial')), [], 'no partial left');
  }, { env: { FAKE_DOCKER_CP_FAIL: '1' } });
});

test('ext delete: archive:false deletes immediately; restore refuses a taken name and a missing owner', async () => {
  await withPanel(async (panel) => {
    await setupAdmin(panel);
    await makeDesk(panel, 'desk-now');
    const now = await panel.req('DELETE', '/api/ext/machines/desk-now', { headers: AUTH, body: { confirm: 'desk-now', archive: false } });
    assert.equal(now.status, 200, now.text);
    assert.equal((await panel.req('GET', '/api/ext/archives', { headers: AUTH })).json.archives.length, 0, 'no copy kept');

    await makeDesk(panel, 'desk-a', 'carol');
    const del = await panel.req('DELETE', '/api/ext/machines/desk-a', { headers: AUTH, body: { confirm: 'desk-a' } });
    assert.equal((await waitJob(panel, del.json.job.id)).status, 'done');
    const id = (await panel.req('GET', '/api/ext/archives', { headers: AUTH })).json.archives[0].id;

    await makeDesk(panel, 'desk-a', 'carol'); // the name is reused meanwhile
    let r = await panel.req('POST', `/api/ext/archives/${id}/restore`, { headers: AUTH, body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'NAME_TAKEN');

    await panel.req('DELETE', '/api/ext/users/carol', { headers: AUTH, body: { deleteMachines: false } });
    r = await panel.req('POST', `/api/ext/archives/${id}/restore`, { headers: AUTH, body: { name: 'desk-a2' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'OWNER_UNAVAILABLE');

    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'dave' } });
    r = await panel.req('POST', `/api/ext/archives/${id}/restore`, { headers: AUTH, body: { name: 'desk-a2', owner: 'dave' } });
    assert.equal(r.status, 202, r.text);
    const job = await waitJob(panel, r.json.job.id);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.owner, 'dave', 'restored to the new owner');

    assert.equal((await panel.req('POST', '/api/ext/archives/not-an-id/restore', { headers: AUTH, body: {} })).status, 400);
    assert.equal((await panel.req('POST', '/api/ext/archives/0123456789abcdef/restore', { headers: AUTH, body: {} })).status, 404);
    assert.equal((await panel.req('GET', '/api/ext/jobs/0123456789abcdef', { headers: AUTH })).status, 404);
  });
});

test('ext archives: purge removes a copy now', async () => {
  await withPanel(async (panel) => {
    await setupAdmin(panel);
    await makeDesk(panel, 'desk-p');
    const del = await panel.req('DELETE', '/api/ext/machines/desk-p', { headers: AUTH, body: { confirm: 'desk-p' } });
    await waitJob(panel, del.json.job.id);
    const id = (await panel.req('GET', '/api/ext/archives', { headers: AUTH })).json.archives[0].id;
    assert.equal((await panel.req('DELETE', `/api/ext/archives/${id}`, { headers: AUTH })).status, 200);
    assert.equal((await panel.req('DELETE', `/api/ext/archives/${id}`, { headers: AUTH })).status, 404);
    assert.equal(fs.existsSync(path.join(panel.dataDir, 'archives', `${id}.tar.gz`)), false);
  });
});

test('ext: rename, logs, ready, stats, unpause, templates, files', async () => {
  await withPanel(async (panel) => {
    await setupAdmin(panel);
    await makeDesk(panel, 'desk-x');
    const ren = await panel.req('PATCH', '/api/ext/machines/desk-x/rename', { headers: AUTH, body: { displayName: '  Finance  ' } });
    assert.equal(ren.status, 200);
    assert.equal(ren.json.displayName, 'Finance');

    const logs = await panel.req('GET', '/api/ext/machines/desk-x/logs?tail=100', { headers: AUTH });
    assert.equal(logs.status, 200);
    assert.match(logs.json.text, /fake log line 1/);
    assert.equal((await panel.req('GET', '/api/ext/machines/ghost/logs', { headers: AUTH })).status, 404);

    assert.equal((await panel.req('GET', '/api/ext/machines/desk-x/ready', { headers: AUTH })).status, 200);
    const stats = await panel.req('GET', '/api/ext/machines/desk-x/stats', { headers: AUTH });
    assert.equal(stats.status, 200);
    assert.equal(stats.json.name, 'desk-x');

    assert.ok((await panel.req('POST', '/api/ext/machines/desk-x/action', { headers: AUTH, body: { action: 'unpause' } })).status < 300, 'unpause accepted');

    const t = await panel.req('GET', '/api/ext/templates', { headers: AUTH });
    assert.ok(t.json.templates.some((x) => x.id === 'linux-desktop'));

    const files = await panel.req('GET', '/api/ext/machines/desk-x/files', { headers: AUTH });
    assert.equal(files.status, 200);
    assert.equal(files.json.dir, '/home/kasm-user/Uploads');
    assert.equal((await panel.req('DELETE', '/api/ext/machines/desk-x/files/..%2Fsecret', { headers: AUTH })).status, 400, 'traversal rejected');
    assert.equal((await panel.req('DELETE', '/api/ext/machines/desk-x/files/report.pdf', { headers: AUTH })).status, 200);
  });
});

test('ext: resources + settings; settings persist, keep other keys, and refuse security keys', async () => {
  await withPanel(async (panel) => {
    await setupAdmin(panel);
    await makeDesk(panel, 'desk-r');
    const r = await panel.req('GET', '/api/ext/resources', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.ok(r.json.host.cpus > 0 && r.json.host.memTotalBytes > 0, 'host snapshot');
    assert.equal(r.json.limits.maxRunningMachines, 4);
    assert.equal(r.json.limits.running, 1);
    assert.ok(Array.isArray(r.json.alerts));
    assert.ok(r.json.machines.some((m) => m.name === 'desk-r'));

    const bad = await panel.req('PATCH', '/api/ext/settings', { headers: AUTH, body: { panelApiToken: 'x'.repeat(40) } });
    assert.equal(bad.status, 400, 'token cannot be changed through the API');
    assert.equal((await panel.req('PATCH', '/api/ext/settings', { headers: AUTH, body: { maxRunningMachines: -1 } })).status, 400);
    assert.equal((await panel.req('PATCH', '/api/ext/settings', { headers: AUTH, body: {} })).status, 400);

    const ok = await panel.req('PATCH', '/api/ext/settings', { headers: AUTH, body: { maxRunningMachines: 1, idleStopMinutes: 90 } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.settings.maxRunningMachines, 1);
    assert.equal(ok.json.settings.idleStopMinutes, 90);
    const onDisk = JSON.parse(fs.readFileSync(path.join(panel.dataDir, 'config.json'), 'utf8'));
    assert.equal(onDisk.maxRunningMachines, 1);
    assert.equal(onDisk.embedOrigins?.[0], 'https://keep.example', 'unrelated keys preserved');
    assert.equal(fs.statSync(path.join(panel.dataDir, 'config.json')).mode & 0o777, 0o600);

    // Applied live: a second desktop is now over the limit.
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'erin' } });
    const over = await panel.req('POST', '/api/ext/machines', { headers: AUTH, body: { owner: 'erin', template: 'linux-desktop', name: 'desk-r2' } });
    assert.equal(over.status, 503);
    assert.equal(over.json.error.code, 'AT_CAPACITY');

    const audit = await panel.req('GET', '/api/ext/audit?limit=50', { headers: AUTH });
    assert.ok(audit.json.entries.some((e) => e.action === 'settings.update'), 'settings change audited');
    assert.equal((await panel.req('GET', '/api/ext/metrics?points=5', { headers: AUTH })).status, 200);
    assert.equal((await panel.req('GET', '/api/ext/usage', { headers: AUTH })).status, 200);
  }, { config: { maxRunningMachines: 4, embedOrigins: ['https://keep.example'] } });
});

test('ext management endpoints all require the bearer token', async () => {
  await withPanel(async (panel) => {
    await setupAdmin(panel);
    for (const [method, p] of [
      ['GET', '/api/ext/resources'], ['GET', '/api/ext/settings'], ['PATCH', '/api/ext/settings'],
      ['GET', '/api/ext/archives'], ['DELETE', '/api/ext/machines/x'], ['GET', '/api/ext/audit'],
      ['GET', '/api/ext/machines/x/files'], ['GET', '/api/ext/machines/x/logs'],
    ]) {
      const r = await panel.req(method, p, { body: method === 'GET' ? undefined : {} });
      assert.equal(r.status, 401, `${method} ${p} without token`);
    }
  });
});
