// Pure auth primitives for VM Panel: scrypt password hashing, HMAC-signed
// session cookies, cookie parsing, password policy, and login rate limiting.
// No filesystem access in this module.

import crypto from 'node:crypto';

// ---- Password hashing (scrypt) ----------------------------------------------
// N = 2^17, r = 8, p = 1 — the current OWASP minimum for scrypt (the previous
// 2^14 was three doublings below it). Memory cost is 128*N*r = 128 MiB per
// derivation, which EXCEEDS Node's default 32 MiB scrypt maxmem, so `maxmem`
// must be passed explicitly on every call (see scryptAsync) or Node throws
// ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
//
// Params are stored per user, so raising them here does not invalidate existing
// credentials: an old record keeps verifying with its own (weaker) params, and
// only gets the stronger ones the next time that password is set.
export const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1, keylen: 64 };

// Headroom over 128*N*r so a stored record with slightly different params still
// verifies rather than throwing.
const SCRYPT_MAXMEM = 192 * 1024 * 1024;

// Hard upper bound on any password we will hash/verify. The policy caps real
// passwords at 128; this is a defensive ceiling so a pathological multi-MB login
// body cannot be fed into scrypt (verify has no policy check before hashing).
export const MAX_PASSWORD_BYTES = 1024;

// Bound concurrent scrypt derivations: each holds a libuv threadpool slot and now
// ~128 MiB, so an unauthenticated login burst could otherwise starve the pool
// (fs persistence, other crypto) AND spike memory. Excess derivations queue for a
// free slot. Held at 2 rather than 4 so peak scrypt memory stays ~256 MiB after
// the N increase; the default libuv pool is 4 threads, so this also leaves room
// for filesystem work to proceed during a login burst.
const SCRYPT_MAX_CONCURRENCY = 2;
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
    // maxmem is REQUIRED: 128*N*r at N=2^17 is 128 MiB, four times Node's default
    // 32 MiB ceiling, and without it scrypt rejects the params outright.
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
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
// Length alone let through "aaaaaaaaaa" and "1234567890", which are the first
// candidates any password-spraying tool tries. Length is still the dominant
// factor, so the additions below reject only the structurally worthless cases
// rather than imposing character-class rules (which push users toward
// predictable substitutions without adding real entropy).

// Passwords that are worthless ON THEIR OWN. Matched against the WHOLE password
// after normalisation, not as substrings: a substring rule would reject a strong
// passphrase merely because "password" appears inside it, which pushes users
// toward shorter, more predictable choices for no security gain (NIST 800-63B
// makes the same point — screen the candidate itself, do not impose composition
// rules).
const WEAK_PASSWORDS = new Set([
  'password', 'passw0rd', 'letmein', 'welcome', 'qwerty', 'qwertyuiop', 'asdfghjkl',
  'zxcvbnm', 'iloveyou', 'admin', 'administrator', 'changeme', 'secret', 'default',
  'abcdefg', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  'trustno', 'starwars', 'whatever', 'freedom', 'shadow', 'master', 'superman',
  'vmpanel', 'prism', 'sublimecare', 'desktop', 'contractor', 'temporary',
]);

// Reduce a candidate to the token a guessing list would actually contain:
// lowercase, drop everything that is not a letter or digit, then drop trailing
// digits (the near-universal "password2026" decoration) and leading/trailing
// repetition. "P@ssw0rd!!" and "password123" both reduce to a listed entry;
// "correct-horse-battery-password" does not.
function weakCore(pw) {
  const lower = pw.toLowerCase();
  const flat = lower.replace(/[^a-z0-9]/g, '');
  // Leet-folded variant: substitute, then keep letters only, so trailing "!!" or
  // "2026" fall away and "P@ssw0rd!!" reduces to "password".
  const folded = [...lower].map((c) => LEET[c] ?? c).join('').replace(/[^a-z]/g, '');
  const out = new Set();
  for (const base of [flat, folded]) {
    if (!base) continue;
    out.add(base);
    out.add(base.replace(/\d+$/, ''));
    out.add(base.replace(/^\d+/, ''));
  }
  return [...out].filter(Boolean);
}

// Walks of a keyboard row or the digit/alphabet line. Each is DOUBLED so a walk
// that wraps ("1234567890", "0987654321") is still recognised as a contiguous run.
const WALKS = [
  '01234567890123456789',
  'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
  'qwertyuiopqwertyuiop',
  'asdfghjklasdfghjkl',
  'zxcvbnmzxcvbnm',
];

// Is the whole password a single repeated character, or one straight walk along a
// keyboard row / the digits / the alphabet (forwards or backwards)?
function isDegenerateSequence(s) {
  if (s.length < 2) return true;
  const flat = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!flat) return true;
  if (new Set(flat).size === 1) return true;                 // "aaaaaaaaaa"
  // A password that is just a shorter token repeated has only that token's
  // entropy ("adminadmin", "abcabcabcabc"), however long it looks.
  for (let unit = 1; unit <= flat.length / 2; unit++) {
    if (flat.length % unit) continue;
    if (flat === flat.slice(0, unit).repeat(flat.length / unit)) return true;
  }
  for (const walk of WALKS) {
    if (walk.includes(flat)) return true;
    if ([...walk].reverse().join('').includes(flat)) return true;
  }
  return false;
}

// Common character substitutions, so "P@ssw0rd" is screened as "password".
// '!' is deliberately NOT mapped to a letter: it is overwhelmingly used as
// trailing decoration, and mapping it would append noise that defeats the match.
const LEET = { '@': 'a', '4': 'a', '0': 'o', '1': 'i', '3': 'e', '5': 's', $: 's', '7': 't', '8': 'b', '9': 'g' };

// Returns null when acceptable, else a human-readable reason.
// `username` is optional; when given, a password containing it is rejected.
export function validatePassword(pw, { username = null } = {}) {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  if (Buffer.byteLength(pw) > MAX_PASSWORD_BYTES) return 'Password is too long.';
  const lower = pw.toLowerCase();
  if (isDegenerateSequence(pw)) return 'Password cannot be a single repeated character or a simple sequence.';
  // Distinct-character count catches "abababababab" and similar low-entropy
  // padding that the sequence check alone would miss.
  if (new Set(lower).size < 5) return 'Password must use at least 5 different characters.';
  for (const candidate of weakCore(pw)) {
    if (candidate && WEAK_PASSWORDS.has(candidate)) return 'That password is too common. Choose something less predictable.';
  }
  // A password that is only the username (possibly decorated) is guessable by
  // anyone who knows the account exists.
  if (username && typeof username === 'string' && username.length >= 3) {
    const u = username.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (u && weakCore(pw).some((c) => c === u)) return 'Password must not be your username.';
  }
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
// Three buckets, because one alone is always either bypassable or a weapon:
//
//   ips     — 10 failures / 15 min per IP *prefix*. Keyed by prefix, not address:
//             a single IPv6 /64 (a normal residential allocation) holds 2^64
//             addresses, so per-address keying let one attacker mint an unlimited
//             number of fresh buckets.
//   userIp  — 5 failures / 15 min per (username, prefix). This is what actually
//             stops a focused guessing attack, and it only ever penalises the
//             attacker's own network.
//   users   — a high per-username backstop (default 50 / 15 min) for a genuinely
//             distributed attack. It is deliberately NOT 5: a low per-username
//             threshold let any unauthenticated peer lock a known account —
//             including the sole administrator — out of their own panel by
//             submitting five wrong passwords. Real users' typos never reach 50,
//             and an attacker needs many distinct networks to trip it.
//
// Eviction is by least-recent activity, not insertion order. With FIFO eviction an
// attacker could churn `maxBuckets` distinct usernames/IPs to push a victim's
// bucket out of the map and reset their own throttle.
export class LoginLimiter {
  constructor({
    now = Date.now, windowMs = 15 * 60 * 1000,
    ipLimit = 10, userIpLimit = 5, userLimit = 50, maxBuckets = 4000,
  } = {}) {
    this.now = now;
    this.windowMs = windowMs;
    this.ipLimit = ipLimit;
    this.userIpLimit = userIpLimit;
    this.userLimit = userLimit;
    this.maxBuckets = maxBuckets;
    this.ips = new Map();      // ip prefix -> [timestamps]
    this.userIps = new Map();  // "username|prefix" -> [timestamps]
    this.users = new Map();    // username -> [timestamps]
  }

  // Collapse an address to its rate-limiting identity: IPv6 to its /64 routing
  // prefix, IPv4 to the address itself. IPv4-mapped IPv6 is unwrapped first.
  static ipKey(ip) {
    let s = String(ip || '').toLowerCase().trim();
    if (!s) return 'unknown';
    if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined);
    if (s.startsWith('::ffff:')) s = s.slice(7);
    if (!s.includes(':')) return s;                 // IPv4
    // Expand to full groups so a "::" abbreviation cannot hide the prefix.
    const [head, tail = ''] = s.split('::');
    const hp = head ? head.split(':').filter(Boolean) : [];
    const tp = tail ? tail.split(':').filter(Boolean) : [];
    const fill = Math.max(0, 8 - hp.length - tp.length);
    const groups = s.includes('::') ? [...hp, ...Array(fill).fill('0'), ...tp] : s.split(':');
    return groups.slice(0, 4).map((g) => (g || '0').padStart(4, '0')).join(':') + '::/64';
  }

  _prune(list, cutoff) {
    while (list.length && list[0] <= cutoff) list.shift();
  }

  // Make room for a new bucket without ever discarding an ACTIVE BLOCK.
  //
  // Plain LRU is not sufficient here: an attacker who keeps creating buckets can
  // always make the victim's bucket the least-recently-used one and evict it,
  // which resets their own throttle. So eviction only ever considers buckets that
  // are below their limit; a bucket that is currently blocking someone is
  // retained. If nothing is evictable we allow a soft overflow instead — the
  // number of simultaneously-blocking identities is self-limiting, because each
  // one costs the attacker real failed attempts — with a hard multiple as a
  // last-resort memory ceiling.
  _evict(map, cutoff, limit) {
    // 1. Reclaim anything that has fully aged out. Usually enough on its own.
    for (const [k, list] of map) {
      this._prune(list, cutoff);
      if (!list.length) map.delete(k);
    }
    if (map.size < this.maxBuckets) return;
    // 2. Evict the least-recently-active bucket that is NOT blocking.
    let lruKey = null; let lruAt = Infinity;
    for (const [k, list] of map) {
      if (list.length >= limit) continue;            // active block — untouchable
      const last = list[list.length - 1];
      if (last < lruAt) { lruAt = last; lruKey = k; }
    }
    if (lruKey !== null) { map.delete(lruKey); return; }
    // 3. Everything is an active block. Only intervene at the hard ceiling, and
    //    then take the oldest block so memory cannot grow without bound.
    if (map.size >= this.maxBuckets * 4) {
      let oldestKey = null; let oldestAt = Infinity;
      for (const [k, list] of map) {
        const last = list[list.length - 1];
        if (last < oldestAt) { oldestAt = last; oldestKey = k; }
      }
      if (oldestKey !== null) map.delete(oldestKey);
    }
  }

  _bucket(map, key, cutoff, limit) {
    let list = map.get(key);
    if (!list) {
      if (map.size >= this.maxBuckets) this._evict(map, cutoff, limit);
      list = [];
      map.set(key, list);
    }
    return list;
  }

  // Returns { allowed: true } or { allowed: false, retryAfterMs }.
  check(ip, username) {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const prefix = LoginLimiter.ipKey(ip);
    const user = String(username || '').toLowerCase();
    for (const [map, key, limit] of [
      [this.ips, prefix, this.ipLimit],
      [this.userIps, `${user}|${prefix}`, this.userIpLimit],
      [this.users, user, this.userLimit],
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
    const cutoff = t - this.windowMs;
    const prefix = LoginLimiter.ipKey(ip);
    const user = String(username || '').toLowerCase();
    this._bucket(this.ips, prefix, cutoff, this.ipLimit).push(t);
    this._bucket(this.userIps, `${user}|${prefix}`, cutoff, this.userIpLimit).push(t);
    this._bucket(this.users, user, cutoff, this.userLimit).push(t);
  }

  // A success clears this caller's own throttle. The distributed per-username
  // backstop is NOT cleared here: otherwise one successful login from anywhere
  // (including the attacker's own account) would reset the account-wide counter.
  recordSuccess(ip, username) {
    const prefix = LoginLimiter.ipKey(ip);
    const user = String(username || '').toLowerCase();
    this.ips.delete(prefix);
    this.userIps.delete(`${user}|${prefix}`);
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
