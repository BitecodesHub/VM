// Regression tests for the production-hardening pass. Each test here pins a
// specific weakness that was CONFIRMED exploitable against the pre-hardening
// build, so a future change that reopens one fails loudly rather than silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { spawnPanel, setupAdmin, cookieFrom } from './helpers/spawn-panel.js';
import {
  buildRunArgs, deriveBackendPassword, backendAuthFor, networkNameFor,
  TEMPLATES, BACKEND_AUTH_V, DROPPED_CAPS, PIDS_LIMIT,
} from '../lib/core.js';
import { filterRequestHeaders, filterResponseHeaders } from '../lib/proxy.js';

// >=32 chars: the config validator now rejects anything shorter.
const TOKEN = 'prism-hardening-token-abcdefghij0123';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

function raw(port, { method = 'GET', path = '/', headers = {}, body = null, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, method, path, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', (e) => resolve({ status: 0, err: e.message, headers: {}, body: '' }));
    if (body) req.write(body);
    req.end();
  });
}
const cookieOf = (setCookie) => cookieFrom(Array.isArray(setCookie) ? setCookie.join('; ') : setCookie);

// ---------------------------------------------------------------------------
// Container runtime hardening (lib/core.js)
// ---------------------------------------------------------------------------

test('buildRunArgs applies the container hardening flags', () => {
  const args = buildRunArgs({
    template: 'linux-desktop', name: 'desktop-1', ports: { ui: 6201 },
    createdAt: new Date().toISOString(), owner: 'alice', cap: true,
    authSecret: 'test-secret', network: networkNameFor('desktop-1'),
  });
  const joined = args.join(' ');
  assert.match(joined, /--security-opt no-new-privileges/, 'blocks setuid escalation');
  for (const c of DROPPED_CAPS) assert.match(joined, new RegExp(`--cap-drop ${c}`), `drops ${c}`);
  assert.match(joined, new RegExp(`--pids-limit ${PIDS_LIMIT}`), 'bounds pids (fork bomb)');
  assert.match(joined, /--ulimit nofile=/, 'bounds file descriptors');
  assert.match(joined, /--network vmp-net-desktop-1/, 'own network — no lateral reach to other machines');
  assert.match(joined, /--memory 2048m --memory-swap 2048m/, 'memory capped (VM has no swap)');
  // A restart storm on an OOM-killed desktop is what unless-stopped produced.
  assert.match(joined, /--restart on-failure:3/, 'bounded restarts, not unless-stopped');
  assert.doesNotMatch(joined, /--restart unless-stopped/);
});

test('buildRunArgs never uses --internal (desktops need outbound internet)', () => {
  // Guard against "isolate the machine" being implemented by cutting off the
  // internet, which would make a browser desktop useless.
  const args = buildRunArgs({
    template: 'linux-desktop', name: 'desktop-1', ports: { ui: 6201 },
    createdAt: new Date().toISOString(), owner: 'alice', network: 'vmp-net-desktop-1',
  });
  assert.doesNotMatch(args.join(' '), /--internal/);
});

test('backend credentials are per machine, never the shared constant', () => {
  const secret = 'panel-hmac-secret';
  const a = deriveBackendPassword(secret, 'desktop-1');
  const b = deriveBackendPassword(secret, 'desktop-2');
  assert.ok(a && b, 'derives a password');
  assert.notEqual(a, b, 'two machines never share a password');
  assert.notEqual(a, 'secret', 'not the old hardcoded value');
  assert.equal(a, deriveBackendPassword(secret, 'desktop-1'), 'deterministic — recomputable after restart');
  assert.notEqual(a, deriveBackendPassword('other-secret', 'desktop-1'), 'bound to the panel secret');
});

test('buildRunArgs injects the derived VNC_PW and records only the scheme version', () => {
  const secret = 'panel-hmac-secret';
  const args = buildRunArgs({
    template: 'linux-desktop', name: 'desktop-7', ports: { ui: 6201 },
    createdAt: new Date().toISOString(), owner: 'alice', authSecret: secret,
  });
  const joined = args.join(' ');
  const expected = deriveBackendPassword(secret, 'desktop-7');
  assert.match(joined, new RegExp(`VNC_PW=${expected}`), 'container gets the derived password');
  assert.doesNotMatch(joined, /VNC_PW=secret\b/, 'the shared constant is gone');
  assert.match(joined, new RegExp(`vmpanel.authv=${BACKEND_AUTH_V}`), 'records the scheme version');
  // The credential itself must never be a label (labels are readable via inspect
  // and flow into the card object that is serialised to clients).
  assert.ok(!args.some((a, i) => args[i - 1] === '-l' && a.includes(expected)), 'password is not stored in a label');
});

test('backendAuthFor keeps legacy containers working', () => {
  const t = TEMPLATES['linux-desktop'];
  const legacy = backendAuthFor(t, { name: 'desktop-1', authV: 1, secret: 'panel-hmac-secret' });
  assert.deepEqual(legacy, t.backendAuth, 'no authv label → template constant (pre-existing containers)');
  const modern = backendAuthFor(t, { name: 'desktop-1', authV: BACKEND_AUTH_V, secret: 'panel-hmac-secret' });
  assert.equal(modern.pass, deriveBackendPassword('panel-hmac-secret', 'desktop-1'));
  assert.equal(modern.user, t.backendAuth.user);
});

// ---------------------------------------------------------------------------
// Proxy response/request sanitisation (lib/proxy.js)
// ---------------------------------------------------------------------------

test('proxy strips container-controlled response headers', () => {
  // A user can replace the listener on their own machine's port; anything it
  // sets here would act on another user's browser.
  const out = filterResponseHeaders({
    'content-type': 'text/html',
    'set-cookie': 'vmp_session=ATTACKER; Path=/api',
    'access-control-allow-origin': 'https://evil.example',
    'access-control-allow-credentials': 'true',
    'x-frame-options': 'ALLOWALL',
    'content-security-policy': "default-src *",
    'strict-transport-security': 'max-age=0',
  });
  for (const h of ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials',
    'x-frame-options', 'content-security-policy', 'strict-transport-security']) {
    assert.ok(!(h in out), `${h} must not pass through`);
  }
  assert.equal(out['content-type'], 'text/html', 'ordinary headers still pass');
});

test('proxy does not forward Referer or client Authorization to containers', () => {
  const out = filterRequestHeaders({
    host: 'panel:5051',
    cookie: 'vmp_session=panel-session',
    // The SSO redeem URL carries a single-use token in its query string.
    referer: 'http://panel:5051/sso?t=LIVE_SSO_TOKEN',
    authorization: 'Basic YXR0YWNrZXI6cHc=',
    'user-agent': 'test',
  }, { port: 6901, remoteAddr: '127.0.0.1' });
  assert.ok(!('referer' in out), 'Referer would leak the SSO token to the container');
  assert.ok(!Object.keys(out).some((k) => k.toLowerCase() === 'authorization'), 'client credentials never reach a backend');
  assert.ok(!('cookie' in out), 'panel session cookie never reaches a backend');
  assert.equal(out['user-agent'], 'test', 'ordinary headers still forwarded');
});

// ---------------------------------------------------------------------------
// First-run admin claim
// ---------------------------------------------------------------------------

test('concurrent first-run setup creates exactly one admin', async () => {
  const panel = await spawnPanel({});
  try {
    const [a, b] = await Promise.all([
      panel.req('POST', '/api/setup', { body: { username: 'legit', password: 'legit-password-11' } }),
      panel.req('POST', '/api/setup', { body: { username: 'attacker', password: 'attacker-pass-11' } }),
    ]);
    const created = [a, b].filter((r) => r.status === 201).length;
    assert.equal(created, 1, `exactly one admin (statuses ${a.status}/${b.status})`);
  } finally { panel.kill(); }
});

test('a burst of concurrent setups still creates exactly one admin', async () => {
  const panel = await spawnPanel({});
  try {
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      panel.req('POST', '/api/setup', { body: { username: `user${i}aa`, password: `burst-password-${i}${i}` } })));
    assert.equal(burst.filter((r) => r.status === 201).length, 1, 'only one winner');
  } finally { panel.kill(); }
});

test('remote first-run setup requires the boot-printed token; loopback does not', async (t) => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!lan) return t.skip('no non-loopback interface on this host');
  const panel = await spawnPanel({ env: { VMP_BIND: '0.0.0.0' } });
  try {
    // Dial the real address so the PEER (not just the Host header) is remote —
    // the gate keys off req.socket.remoteAddress.
    const post = (host, body) => {
      const d = JSON.stringify(body);
      return raw(panel.port, {
        host,
        method: 'POST', path: '/api/setup', body: d,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), Origin: `http://${host}:${panel.port}`, Host: `${host}:${panel.port}` },
      });
    };
    const remote = await post(lan, { username: 'remoteadmin', password: 'remote-password-11' });
    assert.equal(remote.status, 403, `a non-loopback peer cannot claim the admin account (got ${remote.status})`);
    assert.match(remote.body, /SETUP_TOKEN_REQUIRED/);
    // ...and the documented local flow is unaffected.
    const local = await post('127.0.0.1', { username: 'localadmin', password: 'local-password-11' });
    assert.equal(local.status, 201, 'setup from the panel host needs no token');
  } finally { panel.kill(); }
});

// ---------------------------------------------------------------------------
// External integration API
// ---------------------------------------------------------------------------

test('ext API rate-limits and audits failed bearer attempts', async () => {
  const panel = await spawnPanel({ env: { VMP_PANEL_API_TOKEN: TOKEN } });
  try {
    await setupAdmin(panel);
    const codes = [];
    for (let i = 0; i < 25; i++) {
      codes.push((await panel.req('GET', '/api/ext/users', { headers: { Authorization: `Bearer wrong-token-guess-${i}${'x'.repeat(20)}` } })).status);
    }
    assert.ok(codes.includes(429), 'brute force is throttled, not answered 401 forever');
    assert.ok(codes.indexOf(429) <= 12, `throttle engages promptly (first 429 at ${codes.indexOf(429) + 1})`);
  } finally { panel.kill(); }
});

test('ext API refuses to create an admin or mint admin SSO', async () => {
  const panel = await spawnPanel({ env: { VMP_PANEL_API_TOKEN: TOKEN } });
  try {
    await setupAdmin(panel);   // creates username "admin", role admin
    // Escalation chain that previously ended in a full admin session:
    //   bearer token -> create admin user -> mint SSO -> redeem -> admin session.
    const asAdmin = await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'attacker', role: 'admin' } });
    assert.equal(asAdmin.status, 403, 'cannot provision an administrator');
    assert.equal(asAdmin.json.error.code, 'ROLE_NOT_PERMITTED');

    const mintAdmin = await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'admin' } });
    assert.equal(mintAdmin.status, 403, 'cannot mint SSO for an existing administrator');

    // The legitimate PRISM paths must still work.
    const asUser = await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'contractor', role: 'user' } });
    assert.equal(asUser.status, 201, 'provisioning a contractor still works');
    const mintUser = await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'contractor' } });
    assert.equal(mintUser.status, 200, 'minting SSO for a contractor still works');
  } finally { panel.kill(); }
});

// ---------------------------------------------------------------------------
// SSO embed session scoping
// ---------------------------------------------------------------------------

test('a machine-scoped SSO session cannot use the panel API or another machine', async () => {
  const panel = await spawnPanel({ env: { VMP_PANEL_API_TOKEN: TOKEN } });
  try {
    const adminCookie = await setupAdmin(panel);
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'contractor', role: 'user' } });
    const mk = async () => {
      const r = await panel.req('POST', '/api/ext/machines', { headers: AUTH, body: { owner: 'contractor', template: 'linux-desktop' } });
      return r.json?.name;
    };
    const mine = await mk();
    const other = await mk();
    assert.ok(mine && other && mine !== other, 'two machines provisioned');

    const mint = await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'contractor', machine: mine } });
    assert.equal(mint.status, 200);
    const redeem = await raw(panel.machinePort, { path: mint.json.path, headers: { Host: `127.0.0.1:${panel.machinePort}` } });
    assert.equal(redeem.status, 302, 'redeem redirects into the screen');
    const embed = cookieOf(redeem.headers['set-cookie']);
    assert.ok(embed, 'embed cookie issued');

    // Cookies are not port-scoped, so this cookie reaches the panel origin too —
    // it must be refused there.
    for (const p of ['/api/users', '/api/state', '/api/audit']) {
      const r = await raw(panel.port, { path: p, headers: { Cookie: embed, Host: `127.0.0.1:${panel.port}` } });
      assert.equal(r.status, 403, `embed session refused on ${p} (got ${r.status})`);
    }

    // Scoped to exactly one machine: another machine is a 404, not an oracle.
    const otherScreen = await raw(panel.machinePort, { path: `/m/${other}/`, headers: { Cookie: embed, Host: `127.0.0.1:${panel.machinePort}` } });
    assert.equal(otherScreen.status, 404, 'cannot reach a machine the link was not minted for');
    const ownScreen = await raw(panel.machinePort, { path: `/m/${mine}/`, headers: { Cookie: embed, Host: `127.0.0.1:${panel.machinePort}` } });
    assert.notEqual(ownScreen.status, 404, 'still reaches its own machine');

    // A normal session is unaffected by the scoping gate.
    const adminState = await raw(panel.port, { path: '/api/state', headers: { Cookie: adminCookie, Host: `127.0.0.1:${panel.port}` } });
    assert.equal(adminState.status, 200, 'ordinary admin session unaffected');
  } finally { panel.kill(); }
});

test('an unscoped SSO session (no machine) still works as a normal login', async () => {
  const panel = await spawnPanel({ env: { VMP_PANEL_API_TOKEN: TOKEN } });
  try {
    await setupAdmin(panel);
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'contractor', role: 'user' } });
    const mint = await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'contractor' } });
    const redeem = await raw(panel.machinePort, { path: mint.json.path, headers: { Host: `127.0.0.1:${panel.machinePort}` } });
    const embed = cookieOf(redeem.headers['set-cookie']);
    const state = await raw(panel.port, { path: '/api/state', headers: { Cookie: embed, Host: `127.0.0.1:${panel.port}` } });
    assert.equal(state.status, 200, 'an unscoped SSO login can use the panel as that user');
  } finally { panel.kill(); }
});

// ---------------------------------------------------------------------------
// Access-log redaction
// ---------------------------------------------------------------------------

test('the access log redacts the single-use SSO token', async () => {
  const panel = await spawnPanel({ env: { VMP_PANEL_API_TOKEN: TOKEN }, config: { accessLog: true, port: 0, bind: '127.0.0.1' } });
  try {
    await setupAdmin(panel);
    await panel.req('POST', '/api/ext/users', { headers: AUTH, body: { username: 'contractor', role: 'user' } });
    const mint = await panel.req('POST', '/api/ext/sso/mint', { headers: AUTH, body: { username: 'contractor' } });
    const token = mint.json.token;
    await raw(panel.machinePort, { path: mint.json.path, headers: { Host: `127.0.0.1:${panel.machinePort}` } });
    await new Promise((r) => setTimeout(r, 250));   // let the log stream flush
    const fs = await import('node:fs');
    const logPath = `${panel.dataDir}/panel-access.log`;
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    assert.ok(!log.includes(token), 'a live SSO token must never be written to the access log');
    if (log.includes('/sso')) assert.match(log, /t=\*\*\*/, 'the token parameter is redacted');
  } finally { panel.kill(); }
});
