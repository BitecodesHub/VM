import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  parseProxyPath, HOP_BY_HOP, filterRequestHeaders, filterResponseHeaders,
  buildUpgradeHead, isAllowedHost, isAllowedOrigin, errorPage, proxyHttp,
} from '../lib/proxy.js';

test('parseProxyPath: valid shapes', () => {
  assert.deepEqual(parseProxyPath('/m/desktop-1'), { name: 'desktop-1', rest: null, query: '' });
  assert.deepEqual(parseProxyPath('/m/desktop-1/'), { name: 'desktop-1', rest: '/', query: '' });
  assert.deepEqual(parseProxyPath('/m/desktop-1/vnc.html'), { name: 'desktop-1', rest: '/vnc.html', query: '' });
  assert.deepEqual(parseProxyPath('/m/a.b_c-d/app/ui.js'), { name: 'a.b_c-d', rest: '/app/ui.js', query: '' });
  const q = parseProxyPath('/m/desktop-1/websockify?path=x&password=y');
  assert.equal(q.name, 'desktop-1');
  assert.equal(q.rest, '/websockify');
  assert.equal(q.query, '?path=x&password=y');
});

test('parseProxyPath: rejects traversal, encoding tricks, junk', () => {
  assert.equal(parseProxyPath('/m/../etc'), null);
  assert.equal(parseProxyPath('/m/a%2Fb/x'), null);       // %2F not a valid name char
  assert.equal(parseProxyPath('/m/--flag/x'), null);
  assert.equal(parseProxyPath('/m/'), null);
  assert.equal(parseProxyPath('/m'), null);
  assert.equal(parseProxyPath('/moo/x'), null);
  assert.equal(parseProxyPath(`/m/${'a'.repeat(65)}/x`), null);
  assert.equal(parseProxyPath('/m/a b/x'), null);
});

test('filterRequestHeaders drops hop-by-hop, cookie; rewrites host; adds XFF', () => {
  const out = filterRequestHeaders({
    host: '192.168.1.20:5050',
    cookie: 'vmp_session=secret-value',
    connection: 'keep-alive, X-Custom',
    'x-custom': 'dropme',
    'transfer-encoding': 'chunked',
    accept: 'text/html',
  }, { port: 6081, remoteAddr: '192.168.1.99' });
  assert.equal(out.host, '127.0.0.1:6081');
  assert.equal(out.cookie, undefined);
  assert.equal(out['x-custom'], undefined);
  assert.equal(out['transfer-encoding'], undefined);
  assert.equal(out.connection, undefined);
  assert.equal(out.accept, 'text/html');
  assert.equal(out['x-forwarded-for'], '192.168.1.99');
  assert.equal(out['x-forwarded-host'], '192.168.1.20:5050');
  assert.equal(out['x-forwarded-proto'], 'http');
});

test('filterResponseHeaders drops hop-by-hop only', () => {
  const out = filterResponseHeaders({
    'content-type': 'text/html', connection: 'keep-alive', 'transfer-encoding': 'chunked', etag: 'x',
  });
  assert.deepEqual(out, { 'content-type': 'text/html', etag: 'x' });
  assert.ok(HOP_BY_HOP.has('upgrade'));
});

test('buildUpgradeHead preserves ws headers, rewrites host+origin, drops cookie', () => {
  const head = buildUpgradeHead({
    method: 'GET',
    target: '/websockify',
    port: 6081,
    rawHeaders: [
      'Host', '192.168.1.20:5050',
      'Upgrade', 'websocket',
      'Connection', 'Upgrade',
      'Sec-WebSocket-Key', 'AbC123==',
      'Sec-WebSocket-Version', '13',
      'Sec-WebSocket-Protocol', 'binary',
      'Origin', 'http://192.168.1.20:5050',
      'Cookie', 'vmp_session=supersecret',
    ],
  });
  assert.ok(head.startsWith('GET /websockify HTTP/1.1\r\n'));
  assert.ok(head.includes('Host: 127.0.0.1:6081\r\n'));
  assert.ok(head.includes('Origin: http://127.0.0.1:6081\r\n'));
  assert.ok(head.includes('Sec-WebSocket-Key: AbC123==\r\n'));
  assert.ok(head.includes('Sec-WebSocket-Protocol: binary\r\n'));
  assert.ok(head.includes('Upgrade: websocket\r\n'));
  assert.ok(!head.toLowerCase().includes('cookie'));
  assert.ok(head.endsWith('\r\n\r\n'));
});

test('buildUpgradeHead: TLS scheme + injected Basic auth for a Kasm backend', () => {
  const head = buildUpgradeHead({
    method: 'GET', target: '/websockify', port: 6901, scheme: 'https',
    auth: { user: 'kasmuser', pass: 'secret' },
    rawHeaders: ['Host', 'h:8443', 'Upgrade', 'websocket', 'Origin', 'https://h:5443'],
  });
  assert.ok(head.includes('Origin: https://127.0.0.1:6901\r\n'), 'origin rewritten with backend scheme');
  assert.ok(head.includes(`Authorization: Basic ${Buffer.from('kasmuser:secret').toString('base64')}\r\n`), 'server-side Basic auth injected');
});

test('buildUpgradeHead: no auth ⇒ no Authorization header; a client-sent one is dropped when we inject', () => {
  const plain = buildUpgradeHead({ method: 'GET', target: '/websockify', port: 6081, rawHeaders: ['Host', 'h:5050', 'Upgrade', 'websocket'] });
  assert.ok(!plain.toLowerCase().includes('authorization'), 'no auth header without backendAuth');
  const injected = buildUpgradeHead({ method: 'GET', target: '/ws', port: 6901, auth: { user: 'k', pass: 'p' }, rawHeaders: ['Authorization', 'Basic clientvalue', 'Upgrade', 'websocket'] });
  assert.ok(!injected.includes('Basic clientvalue'), 'client-supplied Authorization is not forwarded');
  assert.ok(injected.includes(`Authorization: Basic ${Buffer.from('k:p').toString('base64')}\r\n`), 'panel injects its own');
});

// Regression: KasmVNC's HTTP server is CASE-SENSITIVE on the auth header name —
// it 401s a lowercase "authorization" and only accepts "Authorization". Verified
// end-to-end against the live image. proxyHttp must inject the capitalised name
// AND drop any client-sent Authorization (never let the browser drive backend
// auth). We read the backend's rawHeaders because Node lowercases req.headers.
test('proxyHttp injects capitalised Authorization and drops the client one', async () => {
  let raw = [];
  const backend = http.createServer((req, res) => { raw = req.rawHeaders.slice(); res.writeHead(200); res.end('ok'); });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const bport = backend.address().port;
  const front = http.createServer((req, res) => {
    proxyHttp({ req, res, port: bport, target: '/', name: 'm', backendAuth: { user: 'kasm_user', pass: 'secret' } });
  });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fport = front.address().port;
  await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: fport, path: '/', headers: { authorization: 'Basic CLIENTVALUE' } },
      (res) => { res.resume(); res.on('end', resolve); });
    r.on('error', reject); r.end();
  });
  backend.close(); front.close();
  const authIdx = raw.map((h, i) => [h, i]).filter(([h]) => h.toLowerCase() === 'authorization');
  assert.equal(authIdx.length, 1, 'exactly one Authorization reaches the backend');
  assert.equal(authIdx[0][0], 'Authorization', 'capitalised (KasmVNC rejects lowercase)');
  assert.equal(raw[authIdx[0][1] + 1], `Basic ${Buffer.from('kasm_user:secret').toString('base64')}`, 'panel value, not client value');
  assert.ok(!raw.includes('Basic CLIENTVALUE'), 'client-sent Authorization dropped');
});

test('proxyHttp without backendAuth forwards no Authorization', async () => {
  let raw = [];
  const backend = http.createServer((req, res) => { raw = req.rawHeaders.slice(); res.writeHead(200); res.end('ok'); });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const bport = backend.address().port;
  const front = http.createServer((req, res) => { proxyHttp({ req, res, port: bport, target: '/', name: 'm' }); });
  await new Promise((r) => front.listen(0, '127.0.0.1', r));
  const fport = front.address().port;
  await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: fport, path: '/' }, (res) => { res.resume(); res.on('end', resolve); });
    r.on('error', reject); r.end();
  });
  backend.close(); front.close();
  assert.ok(!raw.some((h) => h.toLowerCase() === 'authorization'), 'no injected auth for a plain (noVNC) backend');
});

test('isAllowedHost: localhost and IP literals with right port only', () => {
  assert.equal(isAllowedHost('localhost:5050', 5050), true);
  assert.equal(isAllowedHost('127.0.0.1:5050', 5050), true);
  assert.equal(isAllowedHost('192.168.1.10:5050', 5050), true);
  assert.equal(isAllowedHost('[::1]:5050', 5050), true);
  assert.equal(isAllowedHost('evil.example:5050', 5050), false);
  assert.equal(isAllowedHost('192.168.1.10:80', 5050), false);
  assert.equal(isAllowedHost('192.168.1.10', 5050), false);   // implies port 80
  assert.equal(isAllowedHost('', 5050), false);
  assert.equal(isAllowedHost(undefined, 5050), false);
  assert.equal(isAllowedHost('999.1.1.1:5050', 5050), false); // not a valid IP
  // extraHosts allows a configured mDNS name (case-insensitive), still port-checked
  assert.equal(isAllowedHost('mymac.local:5050', 5050, ['mymac.local']), true);
  assert.equal(isAllowedHost('MyMac.local:5050', 5050, ['mymac.local']), true);
  assert.equal(isAllowedHost('mymac.local:5050', 5050), false);          // not allowed without extraHosts
  assert.equal(isAllowedHost('evil.local:5050', 5050, ['mymac.local']), false);
  assert.equal(isAllowedHost('mymac.local:80', 5050, ['mymac.local']), false); // wrong port
});

test('isAllowedOrigin: http scheme + allowed host', () => {
  assert.equal(isAllowedOrigin('http://192.168.1.10:5050', 5050), true);
  assert.equal(isAllowedOrigin('http://localhost:5050', 5050), true);
  assert.equal(isAllowedOrigin('https://192.168.1.10:5050', 5050), false);
  assert.equal(isAllowedOrigin('http://evil.example:5050', 5050), false);
  assert.equal(isAllowedOrigin(null, 5050), false);
});

test('errorPage renders self-contained html', () => {
  const html = errorPage(502, 'Machine unavailable', 'It may be stopped.');
  assert.ok(html.includes('Machine unavailable'));
  assert.ok(html.includes('It may be stopped.'));
  assert.ok(html.startsWith('<!doctype html>'));
});
