import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnPanel, setupAdmin, cookieFrom } from './helpers/spawn-panel.js';

const TOKEN = 'prism-ext-token-abcdefghijklmnop';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

async function withExtPanel(fn) {
  const panel = await spawnPanel({ env: { VMP_PANEL_API_TOKEN: TOKEN, VMP_EMBED_ORIGINS: 'https://prism.example' } });
  try { await fn(panel); } finally { panel.kill(); }
}

test('/api/ext is 404 when no panel API token is configured', async () => {
  const panel = await spawnPanel({});
  try {
    await setupAdmin(panel);
    const r = await panel.req('GET', '/api/ext/machines', { headers: AUTH });
    assert.equal(r.status, 404, 'feature off → looks like no endpoint');
  } finally { panel.kill(); }
});

test('/api/ext requires the bearer token', async () => {
  await withExtPanel(async (panel) => {
    await setupAdmin(panel);
    assert.equal((await panel.req('GET', '/api/ext/machines')).status, 401, 'no token → 401');
    assert.equal((await panel.req('GET', '/api/ext/machines', { headers: { Authorization: 'Bearer wrong' } })).status, 401, 'wrong token → 401');
    assert.equal((await panel.req('GET', '/api/ext/machines', { headers: AUTH })).status, 200, 'correct token → 200');
  });
});

test('ext: ensure-user is idempotent and appears in the user list', async () => {
  await withExtPanel(async (panel) => {
    await setupAdmin(panel);
    const created = await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'ext-user-1' } });
    assert.equal(created.status, 201);
    assert.equal(created.json.created, true);
    const again = await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'ext-user-1' } });
    assert.equal(again.status, 200);
    assert.equal(again.json.created, false, 'second ensure is a no-op');
    const list = await panel.req('GET', '/api/ext/users', { headers: AUTH });
    assert.ok(list.json.users.some((u) => u.username === 'ext-user-1'));
    // Bad username rejected.
    assert.equal((await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'BAD NAME' } })).status, 400);
  });
});

test('ext: set a machine access ACL (assign), validated against real users', async () => {
  await withExtPanel(async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'viewer1' } });
    // Create a real machine (admin session) with a known name.
    const made = await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop', name: 'shared-desk' } });
    assert.equal(made.status, 202, 'machine created');

    // Assigning to an unknown user is rejected.
    const bad = await panel.req('PUT', '/api/ext/machines/shared-desk/access', { headers: AUTH, body: { sharedWith: ['nobody'] } });
    assert.equal(bad.status, 400);

    // Assigning to a real user succeeds and is reflected on read-back.
    const ok = await panel.req('PUT', '/api/ext/machines/shared-desk/access', { headers: AUTH, body: { sharedWith: ['viewer1'] } });
    assert.equal(ok.status, 200);
    const got = await panel.req('GET', '/api/ext/machines/shared-desk/access', { headers: AUTH });
    assert.deepEqual(got.json.sharedWith, ['viewer1']);

    // The machine shows up in the ext machine list with its sharing.
    const machines = await panel.req('GET', '/api/ext/machines', { headers: AUTH });
    const m = machines.json.machines.find((x) => x.name === 'shared-desk');
    assert.ok(m, 'machine listed');
    assert.deepEqual(m.sharedWith, ['viewer1']);
    assert.equal(m.screenPath, '/m/shared-desk/');
  });
});

test('ext: behind TLS, machineOrigin + SSO url use the public host, not the request Host', async () => {
  const panel = await spawnPanel({
    env: { VMP_PANEL_API_TOKEN: TOKEN },
    config: { publicTls: true, publicHost: 'vm.example.test', machineHttpsPort: 5443, panelHttpsPort: 8443 },
  })
  try {
    await setupAdmin(panel)
    const list = await panel.req('GET', '/api/ext/machines', { headers: AUTH })
    assert.equal(list.json.machineOrigin, 'https://vm.example.test:5443', 'public host, not 127.0.0.1')
    const mint = await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'admin' } })
    assert.match(mint.json.url, /^https:\/\/vm\.example\.test:5443\/sso\?t=/)
  } finally { panel.kill() }
})

test('ext: SSO mint → redeem sets an embed cookie once, then blocks replay', async () => {
  await withExtPanel(async (panel) => {
    await setupAdmin(panel);
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'sso-user' } });

    const mint = await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'sso-user', machine: 'shared-desk' } });
    assert.equal(mint.status, 200);
    assert.ok(mint.json.token && mint.json.url && mint.json.path, 'returns token + url + path');

    // Redeem on the MACHINE origin → 302 with an embed Set-Cookie into the screen.
    const redeem = await panel.req('GET', mint.json.path, { machine: true });
    assert.equal(redeem.status, 302);
    // Redirects into the machine's viewer URL (autoconnect + websockify path),
    // not the bare /m/<name>/ landing that shows a manual Connect button.
    assert.match(redeem.headers.get('location') || '', /^\/m\/shared-desk\//);
    assert.match(redeem.setCookie || '', /SameSite=None/i);
    assert.match(redeem.setCookie || '', /Partitioned/i);

    // The minted session authenticates as the SSO user.
    const cookie = cookieFrom(redeem.setCookie);
    const me = await panel.req('GET', '/api/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.username, 'sso-user');

    // The same link cannot be redeemed twice.
    const replay = await panel.req('GET', mint.json.path, { machine: true });
    assert.equal(replay.status, 401, 'single-use enforced');

    // Minting for an unknown user is rejected.
    assert.equal((await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'ghost' } })).status, 404);
  });
});
