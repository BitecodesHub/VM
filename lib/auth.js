// Pure auth primitives for VM Panel: scrypt password hashing, HMAC-signed
// session cookies, cookie parsing, password policy, and login rate limiting.
// No filesystem access in this module.

import crypto from 'node:crypto';

// ---- Password hashing (scrypt) ----------------------------------------------
// 128*N*r = 16 MiB — safely under Node's default 32 MiB scrypt maxmem.
// Params are stored per-user so they can be raised later without breaking verify.
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

// Hard upper bound on any password we will hash/verify. The policy caps real
// passwords at 128; this is a defensive ceiling so a pathological multi-MB login
// body cannot be fed into scrypt (verify has no policy check before hashing).
export const MAX_PASSWORD_BYTES = 1024;

// Bound concurrent scrypt derivations: each holds a libuv threadpool slot for
// ~100ms / ~16 MiB, so an unauthenticated login burst could otherwise starve the
// pool (fs persistence, other crypto). Excess derivations queue for a free slot.
const SCRYPT_MAX_CONCURRENCY = 4;
let scryptActive = 0;
const scryptQueue = [];
function acquireScryptSlot() {
  if (scryptActive < SCRYPT_MAX_CONCURRENCY) { scryptActive++; return Promise.resolve(); }
  return new Promise((resolve) => scryptQueue.push(resolve));
}
function releaseScryptSlot() {
  const next = scryptQueue.shift();
  if (next) next();            // hand the slot straight to a waiter (active unchanged)
  else scryptActive--;
}

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}
async function scryptGuarded(password, salt, params) {
  await acquireScryptSlot();
  try { return await scryptAsync(password, salt, params); }
  finally { releaseScryptSlot(); }
}

export async function hashPassword(password, params = SCRYPT_PARAMS) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) throw new Error('password too long');
  const salt = crypto.randomBytes(16);
  const key = await scryptGuarded(password, salt, params);
  return {
    hash: key.toString('base64'),
    salt: salt.toString('base64'),
    scrypt: { ...params },
  };
}

// record: { hash, salt, scrypt: {N,r,p,keylen} } — always derives with the
// record's own params, then constant-time compares.
export async function verifyPassword(password, record) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return false;
  if (!record?.hash || !record?.salt || !record?.scrypt) return false;
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  const derived = await scryptGuarded(password, salt, record.scrypt);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// A fixed dummy record so unknown-username verification burns the same time
// as a real scrypt derivation (no username enumeration by timing).
export const DUMMY_RECORD = {
  hash: Buffer.alloc(64).toString('base64'),
  salt: Buffer.alloc(16).toString('base64'),
  scrypt: { ...SCRYPT_PARAMS },
};

// ---- Password policy ---------------------------------------------------------
// Returns null when acceptable, else a human-readable reason.
export function validatePassword(pw) {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  return null;
}

// ---- Session ids + signed cookie values ---------------------------------------
const b64url = (buf) => buf.toString('base64url');

export function newSessionId() {
  return b64url(crypto.randomBytes(32));
}

export function signSessionId(sid, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(sid).digest());
}

// Cookie value format: "<sid>.<sig>". Returns sid when the signature checks out.
export function parseAndVerifyCookieValue(value, secret) {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const sid = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(sid) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = signSessionId(sid, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? sid : null;
}

// Minimal RFC-6265 request-cookie parsing.
export function parseCookies(header) {
  const map = new Map();
  if (typeof header !== 'string' || !header) return map;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !map.has(name)) map.set(name, value);
  }
  return map;
}

// ---- Login rate limiting -------------------------------------------------------
// Per-IP: 10 failures / 15 min. Per-username (as submitted): 5 failures / 15 min.
// Success clears both buckets. Injectable clock for tests.
export class LoginLimiter {
  constructor({ now = Date.now, windowMs = 15 * 60 * 1000, ipLimit = 10, userLimit = 5, maxBuckets = 1000 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.ipLimit = ipLimit;
    this.userLimit = userLimit;
    this.maxBuckets = maxBuckets;
    this.ips = new Map();      // ip -> [timestamps]
    this.users = new Map();    // username -> [timestamps]
  }

  _prune(list, cutoff) {
    while (list.length && list[0] <= cutoff) list.shift();
  }

  _bucket(map, key) {
    let list = map.get(key);
    if (!list) {
      // Cheap LRU cap: drop the oldest-inserted bucket when full.
      if (map.size >= this.maxBuckets) map.delete(map.keys().next().value);
      list = [];
      map.set(key, list);
    }
    return list;
  }

  // Returns { allowed: true } or { allowed: false, retryAfterMs }.
  check(ip, username) {
    const t = this.now();
    const cutoff = t - this.windowMs;
    for (const [map, key, limit] of [
      [this.ips, ip, this.ipLimit],
      [this.users, String(username || '').toLowerCase(), this.userLimit],
    ]) {
      const list = map.get(key);
      if (!list) continue;
      this._prune(list, cutoff);
      if (list.length >= limit) {
        return { allowed: false, retryAfterMs: list[0] + this.windowMs - t };
      }
    }
    return { allowed: true };
  }

  recordFailure(ip, username) {
    const t = this.now();
    this._bucket(this.ips, ip).push(t);
    this._bucket(this.users, String(username || '').toLowerCase()).push(t);
  }

  recordSuccess(ip, username) {
    this.ips.delete(ip);
    this.users.delete(String(username || '').toLowerCase());
  }
}

// ---- Generic sliding-window limiter (authenticated mutating endpoints) --------
// Bounds how fast one authenticated user can fire expensive/side-effectful calls
// (machine create, lifecycle, upload) so a compromised or buggy client cannot
// spawn unbounded docker CLI invocations or fill the disk. `hit` records AND
// checks in one atomic step. Injectable clock for tests.
export class RateLimiter {
  constructor({ now = Date.now, windowMs = 60_000, limit = 30, maxBuckets = 2000 } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.limit = limit;
    this.maxBuckets = maxBuckets;
    this.buckets = new Map(); // key -> [timestamps]
  }

  hit(key) {
    const t = this.now();
    const cutoff = t - this.windowMs;
    let list = this.buckets.get(key);
    if (!list) {
      if (this.buckets.size >= this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value);
      list = [];
      this.buckets.set(key, list);
    }
    while (list.length && list[0] <= cutoff) list.shift();
    if (list.length >= this.limit) return { allowed: false, retryAfterMs: list[0] + this.windowMs - t };
    list.push(t);
    return { allowed: true };
  }
}
