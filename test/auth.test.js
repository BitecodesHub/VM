import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  hashPassword, verifyPassword, DUMMY_RECORD, validatePassword,
  newSessionId, signSessionId, parseAndVerifyCookieValue, parseCookies,
  LoginLimiter, SCRYPT_PARAMS, RateLimiter,
} from '../lib/auth.js';

test('hashPassword/verifyPassword roundtrip', async () => {
  const rec = await hashPassword('correct horse battery');
  assert.ok(rec.hash && rec.salt && rec.scrypt.N === SCRYPT_PARAMS.N);
  assert.equal(await verifyPassword('correct horse battery', rec), true);
  assert.equal(await verifyPassword('wrong password!', rec), false);
});

test('verifyPassword uses stored params, rejects malformed records', async () => {
  const rec = await hashPassword('some password!', { N: 4096, r: 8, p: 1, keylen: 64 });
  assert.equal(rec.scrypt.N, 4096);
  assert.equal(await verifyPassword('some password!', rec), true);
  assert.equal(await verifyPassword('x', null), false);
  assert.equal(await verifyPassword('x', {}), false);
});

test('DUMMY_RECORD verifies false but is well-formed', async () => {
  assert.equal(await verifyPassword('anything at all', DUMMY_RECORD), false);
});

test('validatePassword enforces 10-128 length', () => {
  assert.equal(validatePassword('short'), 'Password must be at least 10 characters.');
  assert.equal(validatePassword('x'.repeat(129)), 'Password must be at most 128 characters.');
  assert.equal(validatePassword(12345), 'Password is required.');
  assert.equal(validatePassword('long enough pw'), null);
});

test('session cookie sign/verify roundtrip and tamper rejection', () => {
  const secret = crypto.randomBytes(32);
  const sid = newSessionId();
  const sig = signSessionId(sid, secret);
  assert.equal(parseAndVerifyCookieValue(`${sid}.${sig}`, secret), sid);
  // tampered sid
  assert.equal(parseAndVerifyCookieValue(`${sid}x.${sig}`, secret), null);
  // tampered sig
  assert.equal(parseAndVerifyCookieValue(`${sid}.${sig.slice(0, -2)}zz`, secret), null);
  // wrong secret
  assert.equal(parseAndVerifyCookieValue(`${sid}.${sig}`, crypto.randomBytes(32)), null);
  // garbage
  assert.equal(parseAndVerifyCookieValue('garbage', secret), null);
  assert.equal(parseAndVerifyCookieValue('.sig', secret), null);
  assert.equal(parseAndVerifyCookieValue('sid.', secret), null);
  assert.equal(parseAndVerifyCookieValue(null, secret), null);
});

test('parseCookies parses first occurrence, ignores junk', () => {
  const m = parseCookies('vmp_session=abc.def; other=1; vmp_session=zzz; =bad; solo');
  assert.equal(m.get('vmp_session'), 'abc.def');
  assert.equal(m.get('other'), '1');
  assert.equal(m.has('solo'), false);
  assert.equal(parseCookies(undefined).size, 0);
});

test('LoginLimiter: per-username lockout at 5, window expiry, success reset', () => {
  let t = 1_000_000;
  const lim = new LoginLimiter({ now: () => t });
  for (let i = 0; i < 5; i++) {
    assert.equal(lim.check('1.1.1.1', 'alice').allowed, true);
    lim.recordFailure('1.1.1.1', 'alice');
  }
  const blocked = lim.check('1.1.1.1', 'alice');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // different IP, same username -> still blocked (username bucket)
  assert.equal(lim.check('2.2.2.2', 'alice').allowed, false);
  // window expiry unblocks
  t += 15 * 60 * 1000 + 1;
  assert.equal(lim.check('1.1.1.1', 'alice').allowed, true);
  // success resets
  lim.recordFailure('1.1.1.1', 'alice');
  lim.recordSuccess('1.1.1.1', 'alice');
  assert.equal(lim.check('1.1.1.1', 'alice').allowed, true);
});

test('LoginLimiter: per-IP lockout at 10 across usernames', () => {
  let t = 5_000_000;
  const lim = new LoginLimiter({ now: () => t });
  for (let i = 0; i < 10; i++) lim.recordFailure('9.9.9.9', `user${i}`);
  assert.equal(lim.check('9.9.9.9', 'fresh-user').allowed, false);
  assert.equal(lim.check('8.8.8.8', 'fresh-user').allowed, true);
});

test('LoginLimiter: username matching is case-insensitive', () => {
  let t = 0;
  const lim = new LoginLimiter({ now: () => t });
  for (let i = 0; i < 5; i++) lim.recordFailure(`ip${i}`, 'Alice');
  assert.equal(lim.check('new-ip', 'alice').allowed, false);
});

test('RateLimiter: allows up to limit, blocks the next, keys are independent, window slides', () => {
  let t = 1000;
  const rl = new RateLimiter({ now: () => t, windowMs: 1000, limit: 3 });
  assert.equal(rl.hit('u').allowed, true);
  assert.equal(rl.hit('u').allowed, true);
  assert.equal(rl.hit('u').allowed, true);
  const blocked = rl.hit('u');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 1000, 'reports a bounded retryAfter');
  assert.equal(rl.hit('v').allowed, true, 'a different key has its own budget');
  t += 1001; // whole window elapses
  assert.equal(rl.hit('u').allowed, true, 'budget refills after the window');
});

test('RateLimiter: caps the number of buckets (LRU-drop oldest)', () => {
  let t = 0;
  const rl = new RateLimiter({ now: () => t, windowMs: 1000, limit: 1, maxBuckets: 2 });
  rl.hit('a'); rl.hit('b'); rl.hit('c'); // 'a' evicted
  assert.equal(rl.buckets.size, 2);
  assert.equal(rl.hit('a').allowed, true, 'evicted key starts fresh');
});
