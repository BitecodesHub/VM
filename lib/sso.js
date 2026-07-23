// One-time, short-TTL, HMAC-signed SSO tokens. PRISM (server-to-server, via the
// bearer-authed POST /api/ext/sso/mint) mints a token for a VM username + an
// optional machine; the browser redeems it exactly once at GET /sso, which sets
// an embed session cookie and redirects into the machine screen. Tokens are
// signed with the panel's HMAC secret (data/secret) — the same key class that
// signs session cookies — so no new secret material is introduced.

import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function mintSsoToken(secret, { username, machine = null, ttlSec = 60, now = Date.now() } = {}) {
  if (typeof username !== 'string' || !username) throw new Error('username required');
  const payload = {
    u: username,
    m: machine || null,
    exp: now + Math.max(1, ttlSec) * 1000,
    jti: crypto.randomBytes(9).toString('base64url'),
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

// Verify signature + expiry. Returns { username, machine, exp, jti } or null.
// Constant-time signature compare; never throws.
export function verifySsoToken(secret, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  const expect = crypto.createHmac('sha256', secret).update(body).digest();
  if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.u !== 'string' || !Number.isFinite(payload.exp)) return null;
  if (payload.exp < now) return null;
  return { username: payload.u, machine: payload.m || null, exp: payload.exp, jti: payload.jti || null };
}

// Bounded single-use tracker: remembers a redeemed jti until it expires, so a
// (still-unexpired) token cannot be replayed. Self-prunes; in-memory only, so a
// panel restart forgets — acceptable given the ~60s token TTL.
export class OneTimeGuard {
  constructor({ now = Date.now, max = 10_000 } = {}) { this.now = now; this.max = max; this.used = new Map(); }
  // Records `jti`; returns true if fresh, false if replayed within its live
  // window. An expired record is reclaimable (the token itself is dead by then,
  // and verifySsoToken rejects it upstream anyway).
  claim(jti, exp) {
    if (!jti) return true;
    const t = this.now();
    if (this.used.size >= this.max) this._prune(t);
    const seenExp = this.used.get(jti);
    if (seenExp !== undefined && seenExp >= t) return false;
    this.used.set(jti, exp || (t + 120_000));
    return true;
  }
  _prune(t) { for (const [k, e] of this.used) if (e < t) this.used.delete(k); }
}
