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

test('ext: docker down → 503 on machines and access, never an empty list or 404', async () => {
  const panel = await spawnPanel({ dockerDown: true, env: { VMP_PANEL_API_TOKEN: TOKEN } });
  try {
    await setupAdmin(panel);
    const list = await panel.req('GET', '/api/ext/machines', { headers: AUTH });
    assert.equal(list.status, 503, 'an outage must not read as "no machines"');
    assert.equal(list.json.error.code, 'DOCKER_UNAVAILABLE');
    assert.equal(list.json.machines, undefined);

    const get = await panel.req('GET', '/api/ext/machines/shared-desk/access', { headers: AUTH });
    assert.equal(get.status, 503, 'an outage must not read as "machine gone"');
    assert.equal(get.json.error.code, 'DOCKER_UNAVAILABLE');

    const put = await panel.req('PUT', '/api/ext/machines/shared-desk/access', { headers: AUTH, body: { sharedWith: [] } });
    assert.equal(put.status, 503);
    assert.equal(put.json.error.code, 'DOCKER_UNAVAILABLE');

    const bad = await panel.req('PUT', '/api/ext/machines/shared-desk/access', { headers: AUTH, body: { sharedWith: 'x' } });
    assert.equal(bad.status, 400, 'body validation still runs first');
  } finally { panel.kill(); }
});

test('ext: docker healthy → empty list is 200 and a missing machine is still 404', async () => {
  await withExtPanel(async (panel) => {
    await setupAdmin(panel);
    const list = await panel.req('GET', '/api/ext/machines', { headers: AUTH });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.machines, []);

    const get = await panel.req('GET', '/api/ext/machines/ghost-desk/access', { headers: AUTH });
    assert.equal(get.status, 404);
    assert.equal(get.json.error.code, 'NOT_FOUND');
    const put = await panel.req('PUT', '/api/ext/machines/ghost-desk/access', { headers: AUTH, body: { sharedWith: [] } });
    assert.equal(put.status, 404);
    assert.equal(put.json.error.code, 'NOT_FOUND');
  });
});

test('ext: user disable/enable + delete revoke access; machine lifecycle action', async () => {
  await withExtPanel(async (panel) => {
    const admin = await setupAdmin(panel)
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'temp-user' } })

    let r = await panel.req('PUT', '/api/ext/users/temp-user/disabled', { headers: AUTH, body: { disabled: true } })
    assert.equal(r.status, 200)
    assert.equal(r.json.user.disabled, true)
    r = await panel.req('PUT', '/api/ext/users/temp-user/disabled', { headers: AUTH, body: { disabled: false } })
    assert.equal(r.json.user.disabled, false)
    assert.equal((await panel.req('PUT', '/api/ext/users/temp-user/disabled', { headers: AUTH, body: {} })).status, 400, 'bad body rejected')

    r = await panel.req('DELETE', '/api/ext/users/temp-user', { headers: AUTH })
    assert.equal(r.status, 200)
    assert.equal(r.json.deleted, true)
    assert.ok(!(await panel.req('GET', '/api/ext/users', { headers: AUTH })).json.users.some((u) => u.username === 'temp-user'))
    assert.equal((await panel.req('DELETE', '/api/ext/users/temp-user', { headers: AUTH })).json.deleted, false, 'delete is idempotent')

    const made = await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop', name: 'life-desk' } })
    assert.equal(made.status, 202)
    assert.equal((await panel.req('POST', '/api/ext/machines/life-desk/action', { headers: AUTH, body: { action: 'nope' } })).status, 400, 'bad action rejected')
    const stop = await panel.req('POST', '/api/ext/machines/life-desk/action', { headers: AUTH, body: { action: 'stop' } })
    assert.ok(stop.status < 300, `stop ok (got ${stop.status} ${JSON.stringify(stop.json)})`)
  })
})

test('ext: behind TLS, machineOrigin + SSO url use the public host, not the request Host', async () => {
  const panel = await spawnPanel({
    env: { VMP_PANEL_API_TOKEN: TOKEN },
    config: { publicTls: true, publicHost: 'vm.example.test', machineHttpsPort: 5443, panelHttpsPort: 8443 },
  })
  try {
    await setupAdmin(panel)
    const list = await panel.req('GET', '/api/ext/machines', { headers: AUTH })
    assert.equal(list.json.machineOrigin, 'https://vm.example.test:5443', 'public host, not 127.0.0.1')
    // Mint for a provisioned CONTRACTOR, not the admin: the ext API refuses to
    // issue SSO for an administrator (that would let the bearer token escalate).
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'contractor', role: 'user' } })
    const mint = await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'contractor' } })
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
    // Path-scoped to that desktop, so a second desktop's cookie cannot replace it.
    assert.match(redeem.setCookie || '', /Path=\/m\/shared-desk\//);

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

test('ext: machine-origin error pages can be shown inside the PRISM frame', async () => {
  const panel = await spawnPanel({ env: { VMP_PANEL_API_TOKEN: TOKEN }, config: { embedOrigins: ['https://prism.example.test'] } })
  try {
    await setupAdmin(panel)
    for (const [p, headers, status] of [
      ['/sso?t=not-a-token', {}, 401],
      ['/m/some-desk/vnc.html', { Accept: 'text/html' }, 401],
      ['/', {}, 404],
    ]) {
      const r = await panel.req('GET', p, { machine: true, headers })
      assert.equal(r.status, status, p)
      assert.equal(r.headers.get('x-frame-options'), null, `${p}: no X-Frame-Options`)
      assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors [^;]*https:\/\/prism\.example\.test/, `${p}: PRISM may frame it`)
      assert.doesNotMatch(r.text, /Back to PRISM Virtual Desktop/, `${p}: no dead-end link inside the frame`)
    }
    // A signed-out screen navigation explains itself instead of redirecting to a 404.
    const r = await panel.req('GET', '/m/some-desk/vnc.html', { machine: true, headers: { Accept: 'text/html' } })
    assert.match(r.text, /Desktop session ended/)
  } finally { panel.kill() }
})

test('ext: a dedicated screen hostname on 443 is the advertised origin; the :5443 origin stays accepted', async () => {
  const panel = await spawnPanel({
    env: { VMP_PANEL_API_TOKEN: TOKEN },
    config: { publicTls: true, publicHost: 'vm.example.test', machineHttpsPort: 5443, panelHttpsPort: 8443, machinePublicHost: 'desk.vm.example.test' },
  })
  try {
    const admin = await setupAdmin(panel)
    const list = await panel.req('GET', '/api/ext/machines', { headers: AUTH })
    assert.equal(list.json.machineOrigin, 'https://desk.vm.example.test', 'standard port, no :443')
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'contractor', role: 'user' } })
    const mint = await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'contractor' } })
    assert.match(mint.json.url, /^https:\/\/desk\.vm\.example\.test\/sso\?t=/)
    const st = await panel.req('GET', '/api/state', { cookie: admin })
    assert.equal(st.json.panel.machineOrigin, 'https://desk.vm.example.test', 'the panel UI opens screens there too')
    const page = await panel.req('GET', '/', { cookie: admin })
    const csp = page.headers.get('content-security-policy') || ''
    assert.match(csp, /frame-src[^;]*https:\/\/desk\.vm\.example\.test/, 'the panel may frame the new origin')
    assert.match(csp, /frame-src[^;]*https:\/\/vm\.example\.test:5443/, 'and still the old one')
  } finally { panel.kill() }
})

test('ext: an invalid screen hostname in config is ignored (falls back to <publicHost>:5443)', async () => {
  const panel = await spawnPanel({
    env: { VMP_PANEL_API_TOKEN: TOKEN },
    config: { publicTls: true, publicHost: 'vm.example.test', machineHttpsPort: 5443, panelHttpsPort: 8443, machinePublicHost: 'bad host/../x' },
  })
  try {
    await setupAdmin(panel)
    assert.equal((await panel.req('GET', '/api/ext/machines', { headers: AUTH })).json.machineOrigin, 'https://vm.example.test:5443')
  } finally { panel.kill() }
})
