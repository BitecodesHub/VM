import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintSsoToken, verifySsoToken, OneTimeGuard } from '../lib/sso.js';

const SECRET = Buffer.from('0123456789abcdef0123456789abcdef');

test('mint → verify round-trips username + machine', () => {
  const now = 1_000_000_000;
  const tok = mintSsoToken(SECRET, { username: 'alice', machine: 'desk-1', ttlSec: 60, now });
  const p = verifySsoToken(SECRET, tok, { now: now + 1000 });
  assert.ok(p);
  assert.equal(p.username, 'alice');
  assert.equal(p.machine, 'desk-1');
  assert.ok(p.jti);
});

test('rejects a tampered body and a wrong secret', () => {
  const now = 1_000_000_000;
  const tok = mintSsoToken(SECRET, { username: 'alice', now });
  const [body, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: now + 60000, jti: 'x' })).toString('base64url');
  assert.equal(verifySsoToken(SECRET, `${forged}.${sig}`, { now }), null, 'swapped body fails signature');
  assert.equal(verifySsoToken(Buffer.from('another-secret-32-bytes-long!!!!'), tok, { now }), null, 'wrong secret fails');
  assert.equal(verifySsoToken(SECRET, 'garbage', { now }), null);
  assert.equal(verifySsoToken(SECRET, '', { now }), null);
});

test('rejects an expired token', () => {
  const now = 1_000_000_000;
  const tok = mintSsoToken(SECRET, { username: 'alice', ttlSec: 30, now });
  assert.ok(verifySsoToken(SECRET, tok, { now: now + 29_000 }), 'valid within TTL');
  assert.equal(verifySsoToken(SECRET, tok, { now: now + 31_000 }), null, 'expired past TTL');
});

test('OneTimeGuard permits first use, blocks replay, prunes expired', () => {
  let t = 1000;
  const g = new OneTimeGuard({ now: () => t });
  assert.equal(g.claim('jti-1', t + 60_000), true, 'first use ok');
  assert.equal(g.claim('jti-1', t + 60_000), false, 'replay blocked');
  assert.equal(g.claim('jti-2', t + 60_000), true, 'different jti ok');
  t += 120_000; // both expire
  g.claim('jti-3', t + 60_000); // triggers no prune at this size, but jti-1 is now expired
  // A fresh jti after expiry of jti-1 succeeds even if it collides after prune.
  assert.equal(g.claim('jti-1', t + 60_000), true, 'expired jti can be reclaimed after prune window');
});
