// SessionStore — file-backed sessions with HMAC-signed cookies.
// Sliding 7-day TTL (extended at most once per hour to bound write amplification);
// create/destroy are write-through, sliding updates flush on a 30s debounce.

import { loadJsonFile, atomicWriteJson } from './store.js';
import { newSessionId, signSessionId, parseAndVerifyCookieValue, parseCookies } from './auth.js';

export const COOKIE_NAME = 'vmp_session';

const DAY = 24 * 60 * 60 * 1000;

export class SessionStore {
  constructor(filePath, secret, {
    ttlMs = 7 * DAY,
    extendIntervalMs = 60 * 60 * 1000,
    maxPerUser = 10,
    flushDebounceMs = 30_000,
    secure = false,
    absoluteMaxMs = 0, // hard lifetime from creation regardless of activity (0 = off)
    idleMs = 0,        // expire after this much inactivity (0 = rely on sliding ttl)
    now = Date.now,
  } = {}) {
    this.filePath = filePath;
    this.secret = secret;
    this.ttlMs = ttlMs;
    this.extendIntervalMs = extendIntervalMs;
    this.maxPerUser = maxPerUser;
    this.flushDebounceMs = flushDebounceMs;
    this.absoluteMaxMs = absoluteMaxMs;
    this.idleMs = idleMs;
    // When the panel is served over HTTPS (publicTls), mark the cookie Secure so
    // it is never sent over a plaintext hop. Off for the LAN/localhost default,
    // where there is no HTTPS origin to attach it to.
    this.secure = secure;
    this.now = now;
    this.sessions = new Map();
    this._flushTimer = null;
    this._dirty = false;
  }

  load() {
    const data = loadJsonFile(this.filePath, { version: 1, sessions: {} });
    this.sessions = new Map(Object.entries(data.sessions || {}));
    this.sweep();
    return this;
  }

  async _persist() {
    this._dirty = false;
    await atomicWriteJson(this.filePath, {
      version: 1,
      sessions: Object.fromEntries(this.sessions),
    });
  }

  _scheduleFlush() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      if (this._dirty) this._persist().catch(() => {});
    }, this.flushDebounceMs);
    this._flushTimer.unref?.();
  }

  async flush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (this._dirty) await this._persist();
  }

  cookieValue(sid) {
    return `${sid}.${signSessionId(sid, this.secret)}`;
  }

  _attrs(embed = false) {
    // Embed sessions are set inside a cross-site iframe (PRISM framing a machine
    // screen), so the cookie MUST be SameSite=None; Secure (+ Partitioned/CHIPS
    // so it survives third-party-cookie phase-out). Normal login cookies stay
    // SameSite=Lax. SameSite=None requires Secure, so embed cookies only function
    // over TLS — which is exactly how the panel is served publicly.
    if (embed) return 'HttpOnly; SameSite=None; Secure; Partitioned; Path=/';
    return `HttpOnly; SameSite=Lax; Path=/${this.secure ? '; Secure' : ''}`;
  }

  setCookieHeader(sid) {
    const maxAge = Math.floor(this.ttlMs / 1000);
    const embed = !!this.sessions.get(sid)?.embed;
    return `${COOKIE_NAME}=${this.cookieValue(sid)}; ${this._attrs(embed)}; Max-Age=${maxAge}`;
  }

  clearCookie() {
    return `${COOKIE_NAME}=; ${this._attrs()}; Max-Age=0`;
  }

  async create(username, { ip = '', userAgent = '', embed = false } = {}) {
    const t = this.now();
    const snapshot = new Map(this.sessions); // for rollback if the write fails
    // Enforce max sessions per user: count only LIVE sessions, evict oldest.
    const mine = [...this.sessions.entries()].filter(([, s]) => s.username === username && s.expiresAt > t);
    if (mine.length >= this.maxPerUser) {
      mine.sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      for (const [sid] of mine.slice(0, mine.length - this.maxPerUser + 1)) this.sessions.delete(sid);
    }
    const sid = newSessionId();
    this.sessions.set(sid, {
      username,
      createdAt: t,
      expiresAt: t + this.ttlMs,
      lastSeenAt: t,
      ip: String(ip).slice(0, 64),
      userAgent: String(userAgent).slice(0, 256),
      ...(embed ? { embed: true } : {}),
    });
    try { await this._persist(); }
    catch (e) { this.sessions = snapshot; throw e; } // memory must match disk
    return { sid, setCookie: this.setCookieHeader(sid) };
  }

  // Resolve from a raw Cookie header. Returns { sid, session } | null.
  resolve(cookieHeader) {
    const value = parseCookies(cookieHeader).get(COOKIE_NAME);
    if (!value) return null;
    const sid = parseAndVerifyCookieValue(value, this.secret);
    if (!sid) return null;
    const session = this.sessions.get(sid);
    if (!session) return null;
    const t = this.now();
    // Expiry: sliding TTL, OR an absolute lifetime cap (bounds a stolen cookie
    // even for an always-active attacker), OR an idle timeout since last use.
    const absExpired = this.absoluteMaxMs && (t - (session.createdAt || 0)) >= this.absoluteMaxMs;
    const idleExpired = this.idleMs && (t - (session.lastSeenAt || 0)) >= this.idleMs;
    if (session.expiresAt <= t || absExpired || idleExpired) {
      this.sessions.delete(sid);
      this._scheduleFlush();
      return null;
    }
    session.lastSeenAt = t;
    // Sliding extension, at most once per extendIntervalMs. When it slides, hand
    // back a fresh cookie so the client's Max-Age actually tracks the server TTL
    // (otherwise an always-active user is still logged out at a hard 7 days).
    let refreshedCookie = null;
    if (session.expiresAt - this.ttlMs + this.extendIntervalMs <= t) {
      session.expiresAt = t + this.ttlMs;
      this._scheduleFlush();
      refreshedCookie = this.setCookieHeader(sid);
    }
    return { sid, session, refreshedCookie };
  }

  async destroy(sid) {
    if (this.sessions.delete(sid)) await this._persist();
  }

  async destroyForUser(username, exceptSid = null) {
    let changed = false;
    for (const [sid, s] of this.sessions) {
      if (s.username === username && sid !== exceptSid) {
        this.sessions.delete(sid);
        changed = true;
      }
    }
    if (changed) await this._persist();
  }

  countForUser(username) {
    const t = this.now();
    let n = 0;
    for (const s of this.sessions.values()) if (s.username === username && s.expiresAt > t) n++;
    return n;
  }

  sweep() {
    const t = this.now();
    let changed = false;
    for (const [sid, s] of this.sessions) {
      if (s.expiresAt <= t) { this.sessions.delete(sid); changed = true; }
    }
    if (changed) this._scheduleFlush();
  }
}
