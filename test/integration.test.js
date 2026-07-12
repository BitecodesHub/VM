import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnPanel, cookieFrom, setupAdmin, login } from './helpers/spawn-panel.js';

const PW = 'a-strong-password-1';

// Admin-created users start with mustChangePassword; log in and clear it.
async function activate(panel, username, tempPw, newPw = PW) {
  const c = cookieFrom((await panel.req('POST', '/api/login', { body: { username, password: tempPw } })).setCookie);
  const r = await panel.req('PATCH', '/api/me/password', { cookie: c, body: { currentPassword: tempPw, newPassword: newPw } });
  assert.equal(r.status, 200, 'activate password change');
  return c;
}

async function withPanel(opts, fn) {
  const panel = await spawnPanel(opts);
  try { await fn(panel); } finally { panel.kill(); }
}

// ---- Auth flow -------------------------------------------------------------
test('auth: setup gate, login, rate limit, forced change, logout', async () => {
  await withPanel({}, async (panel) => {
    assert.equal((await panel.req('GET', '/api/me')).status, 409, 'me before setup → SETUP_REQUIRED');
    assert.equal((await panel.req('GET', '/api/setup')).json.needed, true);
    const admin = await setupAdmin(panel);
    assert.ok(admin, 'setup returns cookie');
    assert.equal((await panel.req('POST', '/api/setup', { body: { username: 'x', password: PW } })).status, 409, 'second setup blocked');
    assert.equal((await panel.req('GET', '/api/me', { cookie: admin })).json.role, 'admin');

    // wrong password ×5 → rate limited
    let last;
    for (let i = 0; i < 6; i++) last = await panel.req('POST', '/api/login', { body: { username: 'admin', password: 'wrong' } });
    assert.equal(last.status, 429, 'rate limited after repeated failures');

    // forced change gate for an admin-created user
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'bob', password: PW, role: 'user' } });
    const bobRaw = cookieFrom((await panel.req('POST', '/api/login', { body: { username: 'bob', password: PW } })).setCookie);
    assert.equal((await panel.req('POST', '/api/machines', { cookie: bobRaw, body: { template: 'linux-desktop' } })).status, 403, 'blocked until password change');

    // logout clears cookie
    const lo = await panel.req('POST', '/api/logout', { cookie: admin });
    assert.match(lo.setCookie || '', /Max-Age=0/, 'logout clears cookie');
  });
});

// ---- Authz matrix + quota --------------------------------------------------
test('authz: user vs admin, cross-user 404, quota 403', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'bob', password: PW, role: 'user' } });
    const alice = await activate(panel, 'alice', PW);
    const bob = await activate(panel, 'bob', PW);

    // user cannot reach admin surfaces
    assert.equal((await panel.req('GET', '/api/users', { cookie: alice })).status, 403);
    assert.equal((await panel.req('POST', '/api/vm/stop', { cookie: alice })).status, 403);

    // alice creates two; third exceeds quota
    assert.equal((await panel.req('POST', '/api/machines', { cookie: alice, body: { template: 'linux-desktop' } })).status, 202);
    assert.equal((await panel.req('POST', '/api/machines', { cookie: alice, body: { template: 'linux-desktop' } })).status, 202);
    const third = await panel.req('POST', '/api/machines', { cookie: alice, body: { template: 'linux-desktop' } });
    assert.equal(third.status, 403);
    assert.equal(third.json.error.code, 'QUOTA_EXCEEDED');

    // bob cannot see or act on alice's machine → 404 (no existence oracle)
    const aliceMachine = panel.readWorld();
    const name = Object.keys(aliceMachine.containers)[0];
    assert.equal((await panel.req('POST', `/api/machines/${name}/stop`, { cookie: bob })).status, 404);
    const bobState = await panel.req('GET', '/api/state', { cookie: bob });
    assert.equal(bobState.json.machines.length, 0, 'bob sees none of alice\'s machines');

    // admin sees all
    const adminState = await panel.req('GET', '/api/state', { cookie: admin });
    assert.equal(adminState.json.machines.length, 2);
  });
});

// ---- Guards ----------------------------------------------------------------
test('guards: content-type, origin, host', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    // missing content-type on a mutation
    assert.equal((await panel.req('POST', '/api/machines', { cookie: admin, raw: true, headers: { 'Content-Type': 'text/plain' }, body: { template: 'linux-desktop' } })).status, 400);
    // foreign Origin
    assert.equal((await panel.req('POST', '/api/machines', { cookie: admin, headers: { Origin: 'http://evil.example:5050' }, body: { template: 'linux-desktop' } })).status, 400);
    // bad Host — fetch() forbids overriding Host, so use raw http.request.
    const status = await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: panel.port, path: '/api/state', method: 'GET', headers: { Host: 'evil.example:5050', Cookie: admin } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on('error', reject); r.end();
    });
    assert.equal(status, 400, 'foreign Host rejected');
  });
});

// ---- Proxy (real backend + WS) ---------------------------------------------
// Desktops are KasmVNC (backendTls:true) now, so the fake backend serves HTTPS
// with a throwaway self-signed cert — exercising the panel's REAL production
// path (TLS + injected Basic auth relay). The panel connects rejectUnauthorized:false.
const TEST_BACKEND_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUHYqKOfqtCLPF9c+xgp6lhBMSaDAwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcxMjE2NDA1MFoXDTM2MDcw
OTE2NDA1MFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA4ZPunmlKytO/1iJg2Ajq8J/DYgGH6NvDpFh+wfZXGhtr
SSZHvbdm+aCecBzfZfsV58PdD/xiJYuXbEXY02M8aWTMg3jR1baX1oKwyFLVGo7e
Q/8U08KK/UkDcoQXhUEabnWUqORie+sf03TdNRxI1+h6Vwk9ebeV+74yrm7MSX4O
XeVpBTD6snogohXmpqKIEzlqh99jfr898kpD6+/8kw1ywVu5q6D6oOzWHEl5b0yy
48/NNn1QRNXRmPOi834Dvo3yGtzKRcmiHMaB/JSHit3eFdVYP5UwVzmLSsVYBUMU
W/cAFu7LNovIkDbFVR+RaheaSTpXOYyHMsbDu8utlwIDAQABo28wbTAdBgNVHQ4E
FgQU24KVTZEVydygSkix8603RcNPih8wHwYDVR0jBBgwFoAU24KVTZEVydygSkix
8603RcNPih8wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAD+UCCrrYXMqmahBvmclVfBYBl21ZHAo
BsVn9BLZlRYsLWv+Ib/7doFAkj5j61R+wJj+2ppeZSjPXP9Y6rfJJ30DPhU1Wf0w
hSnRUWtKdfPDEp6Uxw+YT6K5+M/lLWoKpOgP9j4s+IdhRapY8J1BlH8glGqNoP2F
XajOnVUmJAgWtbU3sk+rdoNo9dyJKaj07B+DbEkZ15Mmbg85Snm/79Vhh9DstfPH
3ChiPDKrMGkb9YW1FkjXTwbk5cbDZdmjdAJrQjjPG26RUNdvHF7IJIKFl3IZS3Jj
ywS5TIjSUkVhYNyO8gwOMl1/iCfk1o8fD2UoWLeVkRgMpFZYe+7DKj4=
-----END CERTIFICATE-----`;
const TEST_BACKEND_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDhk+6eaUrK07/W
ImDYCOrwn8NiAYfo28OkWH7B9lcaG2tJJke9t2b5oJ5wHN9l+xXnw90P/GIli5ds
RdjTYzxpZMyDeNHVtpfWgrDIUtUajt5D/xTTwor9SQNyhBeFQRpudZSo5GJ76x/T
dN01HEjX6HpXCT15t5X7vjKubsxJfg5d5WkFMPqyeiCiFeamoogTOWqH32N+vz3y
SkPr7/yTDXLBW7mroPqg7NYcSXlvTLLjz802fVBE1dGY86LzfgO+jfIa3MpFyaIc
xoH8lIeK3d4V1Vg/lTBXOYtKxVgFQxRb9wAW7ss2i8iQNsVVH5FqF5pJOlc5jIcy
xsO7y62XAgMBAAECggEAYH4pOnYL2ktN6kl2Z7MY3KlaqJfDDWbEf46jWlEH3VER
SY8obQ0A7ZM5cvfG0BbhvexYqbfqO+lEcrpGD9aJRwQpP6v1Bpg+xzHMcUSNh/jJ
NwjsXdEAJ2yOHvRGI2g/6DQ/zSc0wZFIYenBnjBlMIZvnr+DHofbjn5Dq74VgPGv
hmb2+mhWLd4vGUON3xNNzitl79ax8vIh9X8HJXiJ+1GCZ5vPCBW5mNZmrBKQQKWm
ic377IPRHfckeMAfT4qaUiZD87p9qkXCelPUcAsy2/GtxjnwXC2Tl8394GL52zld
tHDAb8/7QEb04HQRkZ9qovpyL6qGPqcU8sDJoarksQKBgQD2rBq1mXdRoHL8RC64
0H17OmqkUE8ye9prvW5WwntrA8pvDHBA4CkgOptEgLq9+Hovq5XHckpad85c4LBj
xW2couYVilzrQQPwFL9LtXMuMK+ttElcyZZrUaD6kfsKS+i4E3LGJ0lJl3NpbdWz
MHx/BczKgaAXhLfZItESGdnbDQKBgQDqG5/g5xoIIVkCOBLDhMnHfJ7i5dQBgtjx
CemZlVv0T9ZP+7nArllkd4XcnJZYX5eMC8AK94pMvMECbXMmyG2jrmqIHSlFYPjK
OtD2W0vpwGov8Y6yvASnDpqKat7GWlW7OAnjnhPmUwHlnTYKscTEBPJZxyhgYymS
jxg6Ce6yMwKBgBCDFsqfOkiBiBDw83u1oSC1mVvkcFi9x7I8nP07yY0xVMS4PW9q
UfZxVeFxCI8c6fj08HLIaMfDi1HWTJhxJ9Q7Z1F70JqC4KOaj++edtZZtfjXv61x
ZRtL/I2pZfebezmPO7id+p7tf3FIQ+zZywuptLq9kJziangjh4FBr76lAoGAERtl
qnSYxWFSdMQOMvVgHVCw95mdzWJ3Yd28kTmF16uB2KRnZXoYFCxbvsw+fES3+Ube
iK6gD413eSrwUDQzNtPG+x1OZ8B3TafQnz/6oyEpYUmAiPUOTfrWNikrEEmHnD+z
EUv63kjQiavcSBnHbB+EaiUQgUKdxhToy0zwgVsCgYEAppI20BguCRM89xATh1eb
vZspnJpE9mO0I18942n7q9RparoQZF7Zwk0ZIO+tL3kZ/aCn7wp7ZcZ9p2OXr/cc
QSff5z8iWrt3wRu1vINCL9DAMoE11NHZYGRsaTmjAVfhxagiArCvBb58hVlqUUf9
GKFVlQfEB9M5pjr8A0K+0ac=
-----END PRIVATE KEY-----`;

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function startBackend() {
  const state = { lastHeaders: null };
  const srv = https.createServer({ cert: TEST_BACKEND_CERT, key: TEST_BACKEND_KEY }, (req, res) => { state.lastHeaders = req.headers; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>backend</html>'); });
  srv.on('upgrade', (req, socket) => {
    state.upgradeHeaders = req.headers;
    const accept = wsAccept(req.headers['sec-websocket-key']);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.on('data', () => {}); socket.on('error', () => socket.destroy());
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, state, close: () => srv.close() })));
}

// A seeded KasmVNC desktop (both templates are media now). `webcam` sets the
// camera label; template defaults to linux-desktop (XFCE).
function seedMachine(owner, uiPort, state = 'running', { name = 'desktop-1', template = 'linux-desktop', image = 'minimal-linux-desktop:xfce', webcam = null } = {}) {
  const labels = { 'vmpanel.managed': '1', 'vmpanel.template': template, 'vmpanel.owner': owner, 'vmpanel.ui.port': String(uiPort) };
  if (webcam !== null) labels['vmpanel.webcam'] = webcam;
  return { nextId: 2, containers: { [name]: {
    id: 'fake000000001', image, labels,
    ports: { '6901': String(uiPort) }, state, exitCode: 0, startedAt: '2026-07-10T00:00:00Z',
  } } };
}

function seedMediaMachine(owner, uiPort, webcam = '0') {
  return seedMachine(owner, uiPort, 'running', { name: 'media-1', webcam });
}

test('media: stale hostWebcam degrades to audio-only (create succeeds, no 500)', async () => {
  // config.hostWebcam:true but the fake host has no camera device → docker run
  // fails with a device error. The panel must retry without --device, not 500.
  await withPanel({ config: { hostWebcam: true }, env: { FAKE_DOCKER_NO_VIDEO: '1' } }, async (panel) => {
    const admin = await setupAdmin(panel);
    const r = await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop' } });
    assert.equal(r.status, 202, 'media create succeeds (degraded to audio-only), not a 500');
    // The created container carries no --device, so its webcam label is 0.
    const w = panel.readWorld();
    const media = Object.values(w.containers).find((c) => c.labels['vmpanel.template'] === 'linux-desktop');
    assert.ok(media, 'a desktop container was created');
    assert.equal(media.labels['vmpanel.webcam'], '0', 'created without the camera device (audio/mic still work)');
  });
});

test('media: /api/state exposes hostWebcam; card carries media + camera; Basic-auth URL', async () => {
  await withPanel({ world: seedMediaMachine('alice', 6210, '0') }, async (panel) => {
    const admin = await setupAdmin(panel);
    const st = await panel.req('GET', '/api/state', { cookie: admin });
    assert.equal(st.status, 200);
    assert.equal(typeof st.json.panel.hostWebcam, 'boolean', 'state exposes hostWebcam');
    assert.equal(typeof st.json.panel.secureContext, 'boolean', 'state exposes secureContext');
    const card = st.json.machines.find((m) => m.name === 'media-1');
    assert.ok(card, 'media machine is listed (admin sees all)');
    assert.equal(card.media, true, 'card flagged media');
    assert.equal(card.camera, false, 'webcam=0 label → camera reported unavailable');
    assert.ok(card.uiUrl.startsWith('/m/media-1/vnc.html'), 'proxied panel-relative URL');
    assert.ok(card.uiUrl.includes('path=m%2Fmedia-1%2Fwebsockify'), 'noVNC ws path injected');
    assert.ok(!card.uiUrl.includes('password='), 'media auth is Basic (no VNC password in URL)');
  });
});

test('proxy: HTTP strips cookie, 404 foreign, 502 stopped', async () => {
  const backend = await startBackend();
  try {
    await withPanel({ world: seedMachine('alice', backend.port) }, async (panel) => {
      const admin = await setupAdmin(panel);
      await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
      await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'carol', password: PW, role: 'user' } });
      const alice = await activate(panel, 'alice', PW);
      const carol = await activate(panel, 'carol', PW);

      const ok = await panel.req('GET', '/m/desktop-1/vnc.html', { cookie: alice, machine: true });
      assert.equal(ok.status, 200, 'owner reaches proxied backend');
      assert.equal(backend.state.lastHeaders.cookie, undefined, 'panel cookie stripped from backend request');

      // Screens are framed by the panel origin (a different port ⇒ cross-origin),
      // so X-Frame-Options SAMEORIGIN would break them. The proxy must instead
      // scope a CSP frame-ancestors allow-list to exactly the panel origin.
      const csp = ok.headers.get('content-security-policy') || '';
      assert.match(csp, /frame-ancestors/, 'proxied screen sends CSP frame-ancestors');
      assert.match(csp, new RegExp(`:${panel.port}(\\s|$)`), 'frame-ancestors names the panel port, not the machine port');
      assert.equal(ok.headers.get('x-frame-options'), null, 'no X-Frame-Options on screens (would block the cross-origin frame)');
      assert.equal(ok.headers.get('cache-control'), 'no-store', 'screens are no-store so security headers never go stale');

      assert.equal((await panel.req('GET', '/m/desktop-1/vnc.html', { cookie: carol, machine: true })).status, 404, 'foreign user → 404');

      // panel origin does NOT serve /m/ — it 302s to the machine origin (P0-2)
      assert.equal((await panel.req('GET', '/m/desktop-1/vnc.html', { cookie: alice })).status, 302, 'panel origin redirects /m/ to machine origin');

      // stop the machine → 502 (poll until the 5s proxy cache refreshes)
      const w = panel.readWorld(); w.containers['desktop-1'].state = 'exited'; panel.writeWorld(w);
      let sc = 0; for (let i = 0; i < 12; i++) { sc = (await panel.req('GET', '/m/desktop-1/vnc.html', { cookie: alice, machine: true })).status; if (sc === 502) break; await new Promise((r) => setTimeout(r, 600)); }
      assert.equal(sc, 502, 'stopped machine → 502');
    });
  } finally { backend.close(); }
});

test('proxy: WebSocket handshake tunnels through /m/<name>/websockify', async () => {
  const backend = await startBackend();
  try {
    await withPanel({ world: seedMachine('alice', backend.port) }, async (panel) => {
      const admin = await setupAdmin(panel);
      await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
      const alice = await activate(panel, 'alice', PW);
      const key = crypto.randomBytes(16).toString('base64');
      const resp = await new Promise((resolve, reject) => {
        const sock = net.connect(panel.machinePort, '127.0.0.1', () => {
          sock.write(`GET /m/desktop-1/websockify HTTP/1.1\r\nHost: 127.0.0.1:${panel.machinePort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: ${alice}\r\n\r\n`);
        });
        let buf = ''; sock.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n\r\n')) { resolve(buf); sock.destroy(); } });
        sock.on('error', reject); setTimeout(() => reject(new Error('ws timeout: ' + buf)), 4000);
      });
      assert.match(resp, /HTTP\/1\.1 101/, 'panel relays the backend 101 handshake');
      assert.match(resp, new RegExp('Sec-WebSocket-Accept: ' + wsAccept(key).replace(/[+/=]/g, '\\$&')), 'correct accept key relayed');
    });
  } finally { backend.close(); }
});

// ---- Sharing ACL -----------------------------------------------------------
test('sharing: admin grants access; recipient sees + uses, cannot delete', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'bob', password: PW, role: 'user' } });
    const alice = await activate(panel, 'alice', PW);
    const bob = await activate(panel, 'bob', PW);

    await panel.req('POST', '/api/machines', { cookie: alice, body: { template: 'linux-desktop' } });
    const name = Object.keys(panel.readWorld().containers)[0];

    // before sharing: bob cannot see it
    assert.equal((await panel.req('GET', '/api/state', { cookie: bob })).json.machines.length, 0);
    // admin shares to bob
    const put = await panel.req('PUT', `/api/machines/${name}/access`, { cookie: admin, body: { sharedWith: ['bob'] } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.json.sharedWith, ['bob']);
    // bob now sees it with access 'shared'
    const bobState = await panel.req('GET', '/api/state', { cookie: bob });
    assert.equal(bobState.json.machines.length, 1);
    assert.equal(bobState.json.machines[0].access, 'shared');
    assert.equal(bobState.json.machines[0].owner, 'alice');
    // bob can use it (stop) but not delete it
    assert.equal((await panel.req('POST', `/api/machines/${name}/stop`, { cookie: bob })).status, 200);
    assert.equal((await panel.req('DELETE', `/api/machines/${name}`, { cookie: bob, body: { confirm: name } })).status, 403);
    // admin sees sharedWith on the card
    const adminState = await panel.req('GET', '/api/state', { cookie: admin });
    assert.deepEqual(adminState.json.machines.find((mm) => mm.name === name).sharedWith, ['bob']);
    // revoke
    await panel.req('PUT', `/api/machines/${name}/access`, { cookie: admin, body: { sharedWith: [] } });
    assert.equal((await panel.req('GET', '/api/state', { cookie: bob })).json.machines.length, 0);
    // non-admin cannot manage access
    assert.equal((await panel.req('PUT', `/api/machines/${name}/access`, { cookie: alice, body: { sharedWith: ['bob'] } })).status, 403);
  });
});

// ---- P0-2: machine origin cannot escalate to the panel API -----------------
test('P0-2: a request with the machine origin is rejected by the panel API', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    // container JS runs on the machine origin; a mutation it attempts against the
    // panel API carries Origin=machineBase → Origin guard rejects it (400).
    const r = await panel.req('POST', '/api/users', { cookie: admin, headers: { Origin: panel.machineBase }, body: { username: 'evil', password: PW, role: 'admin' } });
    assert.equal(r.status, 400, 'cross-origin (machine→panel) mutation blocked');
  });
});

// ---- P0-1 regression: RST during upgrade does not crash the process --------
test('proxy: client RST during upgrade does not crash the panel', async () => {
  await withPanel({ world: seedMachine('alice', 59999 /* dead backend port */) }, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
    const alice = await activate(panel, 'alice', PW);
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => {
        const sock = net.connect(panel.machinePort, '127.0.0.1', () => {
          sock.write(`GET /m/desktop-1/websockify HTTP/1.1\r\nHost: 127.0.0.1:${panel.machinePort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nCookie: ${alice}\r\n\r\n`);
          sock.resetAndDestroy?.() ?? sock.destroy(); // abrupt RST mid-handshake
          resolve();
        });
        sock.on('error', () => resolve());
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await panel.req('GET', '/healthz')).status, 200, 'panel still alive after RSTs');
  });
});

// ---- Resources / stats / access endpoints (v3) -----------------------------
test('resources + stats + access endpoints', async () => {
  await withPanel({ world: seedMachine('alice', 40000) }, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'bob', password: PW, role: 'user' } });
    const alice = await activate(panel, 'alice', PW);
    const bob = await activate(panel, 'bob', PW);

    // /api/resources shape + role filtering
    const rAdmin = await panel.req('GET', '/api/resources', { cookie: admin });
    assert.equal(rAdmin.status, 200, 'admin resources 200');
    assert.ok(rAdmin.json.capacity && rAdmin.json.used, 'resources has capacity + used');
    if (rAdmin.json.machines.length) assert.ok('owner' in rAdmin.json.machines[0], 'admin machines carry owner');
    const rBob = await panel.req('GET', '/api/resources', { cookie: bob });
    assert.equal(rBob.status, 200, 'non-admin resources 200');
    assert.ok(!JSON.stringify(rBob.json).includes('alice'), 'non-admin resources leak no other usernames');
    assert.ok(rBob.json.machines.every((m) => !('owner' in m)), 'non-admin machines omit owner key');

    // /api/machines/:name/stats
    assert.equal((await panel.req('GET', '/api/machines/desktop-1/stats', { cookie: alice })).status, 200, 'owner stats 200');
    assert.equal((await panel.req('GET', '/api/machines/desktop-1/stats', { cookie: bob })).status, 404, 'foreign stats → 404 (no oracle)');

    // /api/machines/:name/access (admin only)
    assert.equal((await panel.req('GET', '/api/machines/desktop-1/access', { cookie: alice })).status, 403, 'non-admin cannot read access');
    assert.equal((await panel.req('GET', '/api/machines/nope/access', { cookie: admin })).status, 404, 'access GET unknown machine → 404');
    assert.equal((await panel.req('PUT', '/api/machines/desktop-1/access', { cookie: admin, body: { sharedWith: ['ghost'] } })).status, 400, 'unknown user → 400');
    assert.equal((await panel.req('PUT', '/api/machines/desktop-1/access', { cookie: admin, body: { sharedWith: ['alice'] } })).status, 400, 'owner in list → 400');
    assert.equal((await panel.req('PUT', '/api/machines/desktop-1/access', { cookie: admin, body: { sharedWith: 'x' } })).status, 400, 'non-array → 400');
    assert.equal((await panel.req('PUT', '/api/machines/desktop-1/access', { cookie: admin, body: { sharedWith: Array.from({ length: 300 }, (_, i) => `u${i}`) } })).status, 400, 'length cap → 400');
    const ok = await panel.req('PUT', '/api/machines/desktop-1/access', { cookie: admin, body: { sharedWith: ['bob'] } });
    assert.equal(ok.status, 200, 'valid share → 200');
    assert.deepEqual(ok.json.sharedWith, ['bob'], 'share persisted');
  });
});

// ---- VM control state machine + failed-start surfaced ----------------------
test('vm control: already-running 200, failed start surfaced in /api/state', async () => {
  await withPanel({ colimaStatus: 'Running' }, async (panel) => {
    const admin = await setupAdmin(panel);
    const r = await panel.req('POST', '/api/vm/start', { cookie: admin });
    assert.equal(r.status, 200, 'start when already running → 200');
    assert.match(r.json.note || '', /already running/);
  });
  await withPanel({ colimaStatus: 'Stopped', env: { FAKE_COLIMA_START_FAIL: '1' } }, async (panel) => {
    const admin = await setupAdmin(panel);
    assert.equal((await panel.req('POST', '/api/vm/start', { cookie: admin })).status, 202, 'start when stopped → 202');
    let vm = null;
    for (let i = 0; i < 25; i++) {
      vm = (await panel.req('GET', '/api/state', { cookie: admin })).json.vm;
      if (vm.lastResult && vm.lastResult.ok === false) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(vm.lastResult && vm.lastResult.ok === false, 'failed colima start surfaced as vm.lastResult.ok=false');
    assert.equal(vm.lastResult.kind, 'starting');
  });
});

// ---- Error-path hardening --------------------------------------------------
test('hardening: malformed %-encoding → 400, oversized body → 413', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    assert.equal((await panel.req('GET', '/api/machines/%zz/stats', { cookie: admin })).status, 400, 'malformed %-encoding → 400 not 500');
    // Oversized body: server rejects at 64 KiB. Accept 413, or a connection reset
    // (the server destroys the request) — both prove the body was refused.
    let status;
    try { status = (await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop', blob: 'x'.repeat(70 * 1024) } })).status; }
    catch { status = 'reset'; }
    assert.ok(status === 413 || status === 'reset', `oversized body refused (got ${status})`);
  });
});

// ---- Live browser endpoint (Selenium nodes) ---------------------------------
function seedChromeNode(owner, uiPort, wdPort) {
  return { nextId: 2, containers: { 'chrome-node-1': {
    id: 'fake000000009', image: 'local-seleniarm/standalone-chromium:4.5.0-20260701',
    labels: { 'vmpanel.managed': '1', 'vmpanel.template': 'chrome-node', 'vmpanel.owner': owner, 'vmpanel.ui.port': String(uiPort), 'vmpanel.ui.path': '/vnc.html', 'vmpanel.webdriver.port': String(wdPort) },
    ports: { '7900': String(uiPort), '4444': String(wdPort) }, state: 'running', exitCode: 0, startedAt: '2026-07-10T00:00:00Z',
  } } };
}

test('browser endpoint: authz, non-selenium 400, unreachable engine 502, idle close 200', async () => {
  await withPanel({ world: seedChromeNode('alice', 41000, 41001) }, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'carol', password: PW, role: 'user' } });
    const alice = await activate(panel, 'alice', PW);
    const carol = await activate(panel, 'carol', PW);

    // Foreign user cannot even see the node (no oracle).
    assert.equal((await panel.req('POST', '/api/machines/chrome-node-1/browser', { cookie: carol })).status, 404, 'foreign → 404');

    // Owner hits a dead WebDriver port (nothing listens on 41001) → clean 502.
    const dead = await panel.req('POST', '/api/machines/chrome-node-1/browser', { cookie: alice });
    assert.equal(dead.status, 502, 'engine unreachable → 502');
    assert.equal(dead.json.error.code, 'WEBDRIVER_UNREACHABLE');

    // Closing when no session exists is a harmless no-op.
    assert.equal((await panel.req('DELETE', '/api/machines/chrome-node-1/browser', { cookie: alice })).status, 200, 'close with no session → 200');
  });
});

test('browser endpoint: 400 on a non-selenium machine, works against a real fake engine', async () => {
  // A tiny WebDriver stub: POST /session → sessionId; GET url → 200; DELETE → 200.
  const wd = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/session') { req.resume(); return req.on('end', () => res.end(JSON.stringify({ value: { sessionId: 'sess-1', capabilities: {} } }))); }
    if (req.method === 'POST' && /\/session\/sess-1\/url$/.test(req.url)) { req.resume(); return req.on('end', () => res.end(JSON.stringify({ value: null }))); }
    if (req.method === 'GET' && /\/session\/sess-1\/url$/.test(req.url)) return res.end(JSON.stringify({ value: 'about:blank' }));
    if (req.method === 'DELETE') return res.end(JSON.stringify({ value: null }));
    res.statusCode = 404; res.end(JSON.stringify({ value: { message: 'unknown' } }));
  });
  await new Promise((r) => wd.listen(0, '127.0.0.1', r));
  const wdPort = wd.address().port;
  try {
    const world = seedChromeNode('alice', 42000, wdPort);
    // Add a desktop for the 400 case.
    world.containers['desktop-1'] = {
      id: 'fake000000010', image: 'minimal-linux-desktop:xfce',
      labels: { 'vmpanel.managed': '1', 'vmpanel.template': 'linux-desktop', 'vmpanel.owner': 'alice', 'vmpanel.ui.port': '42010', 'vmpanel.ui.path': '/vnc.html' },
      ports: { '6080': '42010' }, state: 'running', exitCode: 0, startedAt: '2026-07-10T00:00:00Z',
    };
    await withPanel({ world }, async (panel) => {
      const admin = await setupAdmin(panel);
      await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
      const alice = await activate(panel, 'alice', PW);

      assert.equal((await panel.req('POST', '/api/machines/desktop-1/browser', { cookie: alice })).status, 400, 'desktop → 400 not a browser node');

      const open = await panel.req('POST', '/api/machines/chrome-node-1/browser', { cookie: alice });
      assert.equal(open.status, 200, 'session created against the stub engine');
      assert.equal(open.json.sessionId, 'sess-1');

      // Idempotent: second open reuses the live session.
      const again = await panel.req('POST', '/api/machines/chrome-node-1/browser', { cookie: alice });
      assert.equal(again.status, 200);
      assert.equal(again.json.reused, true, 'existing live session reused');

      // Card decoration reflects the live session.
      const st = await panel.req('GET', '/api/state', { cookie: alice });
      const card = st.json.machines.find((m) => m.name === 'chrome-node-1');
      assert.equal(card.browserActive, true, 'card decorated browserActive');

      // Close tears it down.
      assert.equal((await panel.req('DELETE', '/api/machines/chrome-node-1/browser', { cookie: alice })).status, 200);
      const st2 = await panel.req('GET', '/api/state', { cookie: alice });
      assert.ok(!st2.json.machines.find((m) => m.name === 'chrome-node-1').browserActive, 'decoration cleared after close');
    });
  } finally { wd.close(); }
});

// ---- Create-time naming + viewer assignment (admin only) -------------------
test('create options: admin names + assigns viewers; users get plain auto-create', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'bob', password: PW, role: 'user' } });
    const alice = await activate(panel, 'alice', PW);
    const bob = await activate(panel, 'bob', PW);

    // Admin: custom name + viewers.
    const made = await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop', name: 'reception-desk', viewers: ['bob'] } });
    assert.equal(made.status, 202, 'admin create with name+viewers');
    assert.equal(made.json.name, 'reception-desk', 'custom name honored');
    assert.deepEqual(made.json.sharedWith, ['bob'], 'viewers applied');

    // The assigned viewer sees it (access=shared) and cannot delete it.
    const bobState = await panel.req('GET', '/api/state', { cookie: bob });
    const seen = bobState.json.machines.find((x) => x.name === 'reception-desk');
    assert.ok(seen, 'assigned viewer sees the machine');
    assert.equal(seen.access, 'shared');
    assert.equal((await panel.req('DELETE', '/api/machines/reception-desk', { cookie: bob, body: { confirm: 'reception-desk' } })).status, 403, 'viewer cannot delete');
    // A non-assigned user cannot see it (no oracle).
    assert.ok(!(await panel.req('GET', '/api/state', { cookie: alice })).json.machines.find((x) => x.name === 'reception-desk'), 'unassigned user does not see it');

    // Resources shared by default; admin can opt a machine into caps (cap:true).
    assert.equal(seen.capped, false, 'default machine is shared (uncapped)');
    const capped = await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop', name: 'capped-desk', cap: true } });
    assert.equal(capped.status, 202);
    const cState = (await panel.req('GET', '/api/state', { cookie: admin })).json.machines.find((x) => x.name === 'capped-desk');
    assert.equal(cState.capped, true, 'cap:true → machine reports capped');

    // Validation: duplicate name → 409, invalid name → 400, unknown viewer → 400.
    assert.equal((await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop', name: 'reception-desk' } })).status, 409, 'duplicate name → 409');
    assert.equal((await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop', name: 'has space' } })).status, 400, 'invalid name → 400');
    assert.equal((await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop', name: 'ok-name', viewers: ['ghost'] } })).status, 400, 'unknown viewer → 400');

    // Regular user: name/viewers are ignored (admin-only) — auto-named, no shares.
    const uMade = await panel.req('POST', '/api/machines', { cookie: alice, body: { template: 'linux-desktop', name: 'alice-pick', viewers: ['bob'] } });
    assert.equal(uMade.status, 202, 'user create ok');
    assert.notEqual(uMade.json.name, 'alice-pick', 'user custom name ignored (auto-named)');
    assert.deepEqual(uMade.json.sharedWith, [], 'user viewers ignored');
  });
});

// ---- Usage accounting endpoint (admin only) --------------------------------
test('usage endpoint: admin-only, returns owners summary shape', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
    const alice = await activate(panel, 'alice', PW);
    assert.equal((await panel.req('GET', '/api/usage', { cookie: alice })).status, 403, 'non-admin forbidden');
    const r = await panel.req('GET', '/api/usage', { cookie: admin });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.owners), 'owners array present');
  });
});

// ---- Metrics endpoints -----------------------------------------------------
test('metrics: /metrics needs admin (no token); /api/metrics admin-only', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
    const alice = await activate(panel, 'alice', PW);
    // /metrics with no session, no token → 401
    assert.equal((await panel.req('GET', '/metrics', { raw: true })).status, 401, 'no auth → 401');
    // admin session → 200 Prometheus text
    const m = await panel.req('GET', '/metrics', { cookie: admin });
    assert.equal(m.status, 200);
    assert.match(m.text, /vmpanel_up 1/);
    // /api/metrics admin-only
    assert.equal((await panel.req('GET', '/api/metrics', { cookie: alice })).status, 403, 'non-admin forbidden');
    const j = await panel.req('GET', '/api/metrics', { cookie: admin });
    assert.equal(j.status, 200);
    assert.ok(Array.isArray(j.json.series), 'series array present');
  });
});

// ---- File transfer (docker cp) ---------------------------------------------
test('files: list/upload authz + validation (cross-user 404, bad filename 400)', async () => {
  await withPanel({ world: seedMachine('alice', 43000) }, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'alice', password: PW, role: 'user' } });
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'bob', password: PW, role: 'user' } });
    const alice = await activate(panel, 'alice', PW);
    const bob = await activate(panel, 'bob', PW);

    // Owner lists files (fake exec → empty list, 200).
    const ls = await panel.req('GET', '/api/machines/desktop-1/files', { cookie: alice });
    assert.equal(ls.status, 200);
    assert.ok(Array.isArray(ls.json.files));

    // Foreign user cannot see it (no oracle).
    assert.equal((await panel.req('GET', '/api/machines/desktop-1/files', { cookie: bob })).status, 404);

    // Bad filename (traversal) rejected before any docker call.
    assert.equal((await panel.req('POST', '/api/machines/desktop-1/files/..%2Fetc%2Fpasswd', { cookie: alice, raw: true, headers: { Origin: panel.base } })).status, 400);
    assert.equal((await panel.req('DELETE', '/api/machines/desktop-1/files/..%2Fx', { cookie: alice })).status, 400);

    // Valid upload (fake cp → success) returns ok.
    const up = await panel.req('POST', '/api/machines/desktop-1/files/report.txt', { cookie: alice, raw: true, body: 'hello', headers: { Origin: panel.base, 'Content-Type': 'application/octet-stream' } });
    assert.equal(up.status, 200, 'valid upload ok');
  });
});

// ---- Batch A: security hardening -------------------------------------------
test('security: shell HTML carries a CSP with frame-src; API JSON does not', async () => {
  await withPanel({}, async (panel) => {
    const html = await panel.req('GET', '/');
    const csp = html.headers.get('content-security-policy');
    assert.ok(csp, 'shell HTML has a CSP');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-src[^;]*127\.0\.0\.1/, 'frame-src names the machine origin');
    // The CSP governs the whole page from the shell; API responses omit it.
    assert.equal((await panel.req('GET', '/api/setup')).headers.get('content-security-policy'), null);
  });
});

test('security: session cookie is Secure only under publicTls', async () => {
  await withPanel({ config: { publicTls: true, publicHost: 'panel.example' } }, async (panel) => {
    const r = await panel.req('POST', '/api/setup', { body: { username: 'admin', password: PW } });
    assert.equal(r.status, 201);
    assert.match(r.setCookie, /;\s*Secure/, 'Secure cookie when served under HTTPS');
  });
  await withPanel({}, async (panel) => {
    const r = await panel.req('POST', '/api/setup', { body: { username: 'admin', password: PW } });
    assert.doesNotMatch(r.setCookie, /;\s*Secure/, 'no Secure on the plaintext LAN default');
  });
});

test('security: docker stderr shown to admins, redacted from regular users', async () => {
  await withPanel({ env: { FAKE_DOCKER_FAIL: '1' } }, async (panel) => {
    const admin = await setupAdmin(panel);
    const a = await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop' } });
    assert.equal(a.status, 500);
    assert.match(a.json.error.stderr || '', /secret-path/, 'admin sees raw docker stderr');

    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'bob', password: PW, role: 'user' } });
    const bob = await activate(panel, 'bob', PW);
    const b = await panel.req('POST', '/api/machines', { cookie: bob, body: { template: 'linux-desktop' } });
    assert.equal(b.status, 500);
    assert.equal(b.json.error.stderr, undefined, 'regular user gets no stderr');
    assert.doesNotMatch(b.json.error.message, /secret-path|permission denied|OCI/, 'no host internals in the message');
  });
});

test('security: expensive machine/VM actions are rate-limited per user (429 + Retry-After)', async () => {
  await withPanel({ config: { actionRateLimit: 2 } }, async (panel) => {
    const admin = await setupAdmin(panel);
    // The limiter runs before routing, so a cheap action on a missing machine
    // still consumes a token. 2 allowed (→404), the 3rd is throttled.
    const a = await panel.req('POST', '/api/machines/nope/stop', { cookie: admin });
    const b = await panel.req('POST', '/api/machines/nope/stop', { cookie: admin });
    const c = await panel.req('POST', '/api/machines/nope/stop', { cookie: admin });
    assert.notEqual(a.status, 429);
    assert.notEqual(b.status, 429);
    assert.equal(c.status, 429, 'third action within the window is throttled');
    assert.equal(c.json.error.code, 'RATE_LIMITED');
    assert.ok(c.headers.get('retry-after'), 'Retry-After header present');
    // A GET (state poll) is never throttled.
    assert.notEqual((await panel.req('GET', '/api/state', { cookie: admin })).status, 429);
  });
});

// ---- Batch B: reliability --------------------------------------------------
test('reliability: /api/state serves the 5s cache (a poll burst = one docker pass)', async () => {
  const countFile = path.join(os.tmpdir(), `vmp-count-${process.pid}-${Math.floor(process.hrtime()[1])}.json`);
  await withPanel({ env: { FAKE_DOCKER_COUNT: countFile } }, async (panel) => {
    const admin = await setupAdmin(panel);
    fs.writeFileSync(countFile, '{}'); // reset after setup + any boot tick
    // 8 rapid polls, well within the 5s TTL.
    for (let i = 0; i < 8; i++) {
      assert.equal((await panel.req('GET', '/api/state', { cookie: admin })).status, 200);
    }
    const counts = JSON.parse(fs.readFileSync(countFile, 'utf8'));
    assert.ok((counts.ps || 0) <= 2, `expected ~1 ps pass for a burst, got ${counts.ps}`);
  });
  try { fs.unlinkSync(countFile); } catch { /* ignore */ }
});

// ---- Batch D: enterprise controls ------------------------------------------
test('audit: privileged actions are logged; admin can read, users cannot', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    await panel.req('POST', '/api/users', { cookie: admin, body: { username: 'carol', password: PW, role: 'user' } });
    const carol = await activate(panel, 'carol', PW);

    // Non-admin is forbidden from the audit log.
    assert.equal((await panel.req('GET', '/api/audit', { cookie: carol })).status, 403);

    const r = await panel.req('GET', '/api/audit', { cookie: admin });
    assert.equal(r.status, 200);
    const actions = r.json.entries.map((e) => e.action);
    assert.ok(actions.includes('setup'), 'setup recorded');
    assert.ok(actions.includes('user.create'), 'user.create recorded');
    assert.ok(actions.includes('login.success'), 'login recorded');
    const created = r.json.entries.find((e) => e.action === 'user.create');
    assert.equal(created.target, 'carol');
    assert.equal(created.actor, 'admin');
  });
});

test('capacity: global running-machine ceiling blocks creates past the limit', async () => {
  await withPanel({ config: { maxRunningMachines: 1 } }, async (panel) => {
    const admin = await setupAdmin(panel);
    assert.equal((await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop' } })).status, 202);
    const second = await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop' } });
    assert.equal(second.status, 503, 'second create hits the global ceiling');
    assert.equal(second.json.error.code, 'AT_CAPACITY');
  });
});

test('state: panel payload surfaces the app version', async () => {
  await withPanel({}, async (panel) => {
    const admin = await setupAdmin(panel);
    const st = await panel.req('GET', '/api/state', { cookie: admin });
    assert.match(String(st.json.panel.version), /^\d+\.\d+\.\d+/, 'semver-ish version present');
  });
});

// ---- Readiness over TLS (KasmVNC desktops) ---------------------------------
test('readiness: a TLS (KasmVNC) backend is probed over HTTPS and reports ready', async () => {
  const backend = await startBackend(); // HTTPS
  try {
    await withPanel({ world: seedMachine('alice', backend.port) }, async (panel) => {
      const admin = await setupAdmin(panel); // admin can probe any machine
      const r = await panel.req('GET', '/api/machines/desktop-1/ready', { cookie: admin });
      assert.equal(r.status, 200);
      assert.equal(r.json.ready, true, 'HTTPS-backed desktop probes ready (not stuck Booting)');
    });
  } finally { backend.close(); }
});
