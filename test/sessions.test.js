import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SessionStore, COOKIE_NAME } from '../lib/sessions.js';

function tmpStore(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-sess-'));
  const secret = crypto.randomBytes(32);
  const store = new SessionStore(path.join(dir, 'sessions.json'), secret, opts).load();
  return { store, secret, dir };
}

test('create/resolve roundtrip with signed cookie', async () => {
  const { store } = tmpStore();
  const { sid, setCookie } = await store.create('alice', { ip: '1.2.3.4', userAgent: 'test' });
  assert.ok(setCookie.startsWith(`${COOKIE_NAME}=`));
  assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax'));
  const cookieHeader = setCookie.split(';')[0];
  const resolved = store.resolve(cookieHeader);
  assert.equal(resolved.sid, sid);
  assert.equal(resolved.session.username, 'alice');
});

test('tampered or foreign cookies do not resolve', async () => {
  const { store } = tmpStore();
  const { setCookie } = await store.create('bob');
  const cookieHeader = setCookie.split(';')[0] + 'x';
  assert.equal(store.resolve(cookieHeader), null);
  assert.equal(store.resolve(`${COOKIE_NAME}=abc.def`), null);
  assert.equal(store.resolve(''), null);
});

test('expiry: session past TTL is rejected and removed', async () => {
  let t = 1_000_000;
  const { store } = tmpStore({ now: () => t, ttlMs: 1000 });
  const { setCookie } = await store.create('carol');
  const cookieHeader = setCookie.split(';')[0];
  t += 1001;
  assert.equal(store.resolve(cookieHeader), null);
  assert.equal(store.countForUser('carol'), 0);
});

test('sliding TTL extends at most once per interval', async () => {
  let t = 0;
  const { store } = tmpStore({ now: () => t, ttlMs: 10_000, extendIntervalMs: 2_000 });
  const { sid, setCookie } = await store.create('dave');
  const cookieHeader = setCookie.split(';')[0];
  const first = store.sessions.get(sid).expiresAt;
  t = 1_000; // within extend interval — no extension
  store.resolve(cookieHeader);
  assert.equal(store.sessions.get(sid).expiresAt, first);
  t = 3_000; // past interval — extends
  store.resolve(cookieHeader);
  assert.equal(store.sessions.get(sid).expiresAt, 13_000);
});

test('maxPerUser evicts oldest session', async () => {
  let t = 0;
  const { store } = tmpStore({ now: () => t, maxPerUser: 3 });
  const cookies = [];
  for (let i = 0; i < 3; i++) { t = i * 1000; cookies.push((await store.create('eve')).setCookie.split(';')[0]); }
  t = 5000;
  await store.create('eve'); // 4th -> evicts oldest
  assert.equal(store.countForUser('eve'), 3);
  assert.equal(store.resolve(cookies[0]), null);      // oldest evicted
  assert.ok(store.resolve(cookies[2]));               // newer survives
});

test('destroyForUser with exception keeps current session', async () => {
  const { store } = tmpStore();
  const a = await store.create('frank');
  const b = await store.create('frank');
  const c = await store.create('grace');
  await store.destroyForUser('frank', a.sid);
  assert.ok(store.resolve(a.setCookie.split(';')[0]));
  assert.equal(store.resolve(b.setCookie.split(';')[0]), null);
  assert.ok(store.resolve(c.setCookie.split(';')[0]));
});

test('destroy is write-through and survives reload', async () => {
  const { store, secret } = tmpStore();
  const a = await store.create('henry');
  const b = await store.create('henry');
  await store.destroy(a.sid);
  const reloaded = new SessionStore(store.filePath, secret).load();
  assert.equal(reloaded.resolve(a.setCookie.split(';')[0]), null);
  assert.ok(reloaded.resolve(b.setCookie.split(';')[0]));
});

test('clearCookie zeroes Max-Age', () => {
  const { store } = tmpStore();
  assert.ok(store.clearCookie().includes('Max-Age=0'));
});

test('resolve re-issues a cookie only when the TTL slides', async () => {
  let t = 1_000_000;
  const { store } = tmpStore({ now: () => t, ttlMs: 1000, extendIntervalMs: 100 });
  const { setCookie } = await store.create('dave');
  const cookieHeader = setCookie.split(';')[0];
  // Within the extend interval: no slide, no fresh cookie.
  assert.equal(store.resolve(cookieHeader).refreshedCookie, null, 'no slide within interval');
  t += 200; // past extendIntervalMs
  const slid = store.resolve(cookieHeader);
  assert.ok(slid.refreshedCookie && slid.refreshedCookie.startsWith(`${COOKIE_NAME}=`), 'slides → re-issues cookie');
  assert.ok(slid.refreshedCookie.includes('Max-Age='), 'refreshed cookie carries Max-Age');
});

test('countForUser excludes expired sessions', async () => {
  let t = 1000;
  const { store } = tmpStore({ now: () => t, ttlMs: 100 });
  await store.create('erin');
  assert.equal(store.countForUser('erin'), 1);
  t += 200; // past TTL
  assert.equal(store.countForUser('erin'), 0, 'expired session not counted');
});

test('expiry: absolute lifetime cap ends an always-active session', async () => {
  let t = 1_000_000;
  const { store } = tmpStore({ now: () => t, ttlMs: 100_000, extendIntervalMs: 10, absoluteMaxMs: 5000 });
  const { setCookie } = await store.create('amy');
  const cookie = setCookie.split(';')[0];
  t += 3000; assert.ok(store.resolve(cookie), 'still valid before the absolute cap (kept alive by activity)');
  t += 3000; // now 6000ms since creation, past the 5s absolute cap
  assert.equal(store.resolve(cookie), null, 'absolute cap forces expiry regardless of activity');
});

test('expiry: idle timeout ends a session after inactivity', async () => {
  let t = 1_000_000;
  const { store } = tmpStore({ now: () => t, ttlMs: 100_000, extendIntervalMs: 10, idleMs: 2000 });
  const { setCookie } = await store.create('ivan');
  const cookie = setCookie.split(';')[0];
  t += 1000; assert.ok(store.resolve(cookie), 'active within the idle window'); // refreshes lastSeenAt
  t += 1500; assert.ok(store.resolve(cookie), 'still active (1.5s since last use < 2s idle)');
  t += 2500; assert.equal(store.resolve(cookie), null, 'idle beyond the timeout expires the session');
});

test('cookie: Secure attribute present only when secure:true; HttpOnly+SameSite always', () => {
  const insecure = new SessionStore('/tmp/vmp-nope.json', 'secret');
  assert.doesNotMatch(insecure.setCookieHeader('sid'), /;\s*Secure/, 'no Secure by default (LAN/http)');
  assert.doesNotMatch(insecure.clearCookie(), /;\s*Secure/);

  const secure = new SessionStore('/tmp/vmp-nope.json', 'secret', { secure: true });
  assert.match(secure.setCookieHeader('sid'), /;\s*Secure/, 'Secure set under publicTls');
  assert.match(secure.clearCookie(), /;\s*Secure/, 'cleared cookie also Secure so it clears over https');

  for (const h of [secure.setCookieHeader('sid'), insecure.setCookieHeader('sid')]) {
    assert.match(h, /HttpOnly/);
    assert.match(h, /SameSite=Lax/);
    assert.match(h, new RegExp(`^${COOKIE_NAME}=`));
  }
});
