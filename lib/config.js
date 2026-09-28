// VM Panel runtime configuration. Loaded once at boot from data/config.json;
// missing file or bad values fall back to defaults (never crash the launchd agent).

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  bind: '::',                // panel listen address (dual-stack IPv4+IPv6)
  port: 5050,
  exposeWebdriver: 'local',  // 'local' | 'lan' — publish address for NEW Selenium 4444 ports
  lanHost: null,             // manual override for the displayed LAN address
  accessLog: true,
  accessLogMaxBytes: 5_000_000,
  maxUpgradedSockets: 64,
  idleStopMinutes: 0,        // auto-stop a desktop with no open screen for this long (0 = off)
  // Resource caps default ON. The Colima VM runs with NO swap, so an uncapped
  // desktop that balloons drives the whole VM into the OOM killer, which then
  // SIGKILLs the largest process rather than the offender (observed: desktops
  // exiting 137). With caps, an OOM is contained to the machine that caused it.
  capResources: true,
  // Per-template default limits for new desktops: { [templateId]: { cpus, memoryMiB } }.
  // Empty = the template's own values (lib/core.js TEMPLATES).
  resourceDefaults: {},
  metricsToken: null,        // bearer token for GET /metrics (null = require an admin session)
  panelApiToken: null,       // bearer token for the /api/ext/* server-to-server API (null = feature OFF)
  // Optional IP allow-list for /api/ext/*. Empty = no IP restriction (the token
  // plus the failure limiter are the control). Strongly recommended when the
  // panel is reachable from anything wider than a trusted LAN. Entries are exact
  // IPs or CIDR blocks, e.g. ["127.0.0.1", "10.0.0.0/8"].
  panelApiAllowFrom: [],
  // Failed-bearer-auth budget per client IP per window, then 429. The ext API is
  // otherwise a single static credential with no lockout, which made offline-speed
  // online brute force possible (measured: 40 wrong tokens in 15ms, all 401).
  panelApiMaxFailures: 10,
  panelApiFailureWindowMinutes: 15,
  embedOrigins: [],          // extra origins allowed to iframe machine screens (e.g. the PRISM app origin)
  alertWebhook: null,        // POST {text} here when a critical alert first fires (null = off)
  actionRateLimit: 60,       // max expensive machine/VM actions per user per minute
  sessionMaxDays: 30,        // absolute session lifetime cap (0 = off) — forces periodic re-login
  sessionIdleHours: 0,       // expire a session after this much inactivity (0 = rely on the 7-day sliding TTL)
  maxRunningMachines: 0,     // global ceiling on concurrently-running panel machines (0 = unlimited)
  // TLS front (Caddy). When publicTls is on, the panel ALSO accepts its public
  // HTTPS origins in the host/origin/CSP guards and emits https:// screen URLs.
  publicTls: false,
  publicHost: null,          // e.g. "macs-macbook-pro.local" (the name on the cert)
  panelHttpsPort: 8443,
  machineHttpsPort: 5443,
  // Webcam for Media Desktops. null = auto-detect (docker daemon host has
  // /dev/video0); true/false = explicit override. On Colima the device lives in
  // the VM (invisible to fs), so set true here AFTER enable-webcam-colima.sh.
  hostWebcam: null,
};

const VALIDATORS = {
  bind: (v) => typeof v === 'string' && v.length > 0,
  port: (v) => Number.isInteger(v) && v > 0 && v < 65536,
  exposeWebdriver: (v) => v === 'local' || v === 'lan',
  lanHost: (v) => v === null || (typeof v === 'string' && v.length > 0),
  accessLog: (v) => typeof v === 'boolean',
  accessLogMaxBytes: (v) => Number.isInteger(v) && v > 0,
  maxUpgradedSockets: (v) => Number.isInteger(v) && v > 0,
  idleStopMinutes: (v) => Number.isInteger(v) && v >= 0,
  capResources: (v) => typeof v === 'boolean',
  resourceDefaults: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  metricsToken: (v) => v === null || (typeof v === 'string' && v.length >= 8),
  // >=32 chars: this single bearer token is the whole authentication for the
  // server-to-server API, and failed attempts are cheap for an attacker, so it
  // must carry real entropy (generate with `openssl rand -base64 32`).
  panelApiToken: (v) => v === null || (typeof v === 'string' && v.length >= 32),
  panelApiAllowFrom: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0),
  panelApiMaxFailures: (v) => Number.isInteger(v) && v > 0,
  panelApiFailureWindowMinutes: (v) => Number.isInteger(v) && v > 0,
  embedOrigins: (v) => Array.isArray(v) && v.every((o) => typeof o === 'string' && /^https?:\/\/[^\s]+$/.test(o)),
  alertWebhook: (v) => v === null || (typeof v === 'string' && /^https?:\/\//.test(v)),
  actionRateLimit: (v) => Number.isInteger(v) && v > 0,
  sessionMaxDays: (v) => Number.isInteger(v) && v >= 0,
  sessionIdleHours: (v) => Number.isInteger(v) && v >= 0,
  maxRunningMachines: (v) => Number.isInteger(v) && v >= 0,
  publicTls: (v) => typeof v === 'boolean',
  publicHost: (v) => v === null || (typeof v === 'string' && v.length > 0),
  panelHttpsPort: (v) => Number.isInteger(v) && v > 0 && v < 65536,
  machineHttpsPort: (v) => Number.isInteger(v) && v > 0 && v < 65536,
  hostWebcam: (v) => v === null || typeof v === 'boolean',
};

// Settings the PRISM integration (/api/ext/settings) may change at runtime.
// Capacity levers only. Everything security- or topology-bearing (tokens,
// allow-lists, origins, hosts, ports, TLS) stays an operator's file edit on the
// host, so a leaked ext token cannot widen its own reach.
export const EXT_EDITABLE = {
  maxRunningMachines: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  idleStopMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 10_080,
  capResources: (v) => typeof v === 'boolean',
  // { [templateId]: { cpus, memoryMiB } } — shape only here; the server checks
  // the template ids and the host's bounds before it saves anything.
  resourceDefaults: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 20
    && Object.entries(v).every(([k, r]) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(k) && r && typeof r === 'object'
      && Number.isFinite(Number(r.cpus)) && Number.isInteger(Number(r.memoryMiB))),
};

// Validate a PATCH body against EXT_EDITABLE. Returns { ok, patch } or
// { ok: false, error } naming the first offending key.
export function validateExtSettingsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be an object' };
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    const check = EXT_EDITABLE[key];
    if (!check) return { ok: false, error: `"${key}" cannot be changed through the integration API` };
    if (!check(value)) return { ok: false, error: `invalid value for "${key}"` };
    patch[key] = value;
  }
  if (!Object.keys(patch).length) return { ok: false, error: 'no settings to change' };
  return { ok: true, patch };
}

// Merge `patch` into data/config.json on disk, preserving every other key
// (tokens, hosts, origins) exactly. Refuses to touch a file it cannot parse:
// rewriting a corrupt config from defaults would silently drop the token.
export async function persistConfigPatch(dataDir, patch, { atomicWriteJson }) {
  const filePath = path.join(dataDir, 'config.json');
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`config.json is unreadable (${e.code || 'invalid JSON'}); not rewriting it`);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('config.json is not an object; not rewriting it');
  await atomicWriteJson(filePath, { ...current, ...patch }, 0o600);
}

export function loadConfig(dataDir, { log = console.error } = {}) {
  const config = { ...DEFAULT_CONFIG };
  const filePath = path.join(dataDir, 'config.json');
  let raw = null;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') log(`config: cannot read ${filePath}: ${e.message} — using defaults`);
  }
  if (raw !== null) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { log(`config: invalid JSON in ${filePath} — using defaults`); }
    if (parsed) {
      for (const [key, validate] of Object.entries(VALIDATORS)) {
        if (key in parsed) {
          if (validate(parsed[key])) config[key] = parsed[key];
          else log(`config: ignoring invalid value for "${key}"`);
        }
      }
    }
  }
  // Env overrides ALWAYS apply (used by integration tests): VMP_PORT accepts 0
  // for an ephemeral port, VMP_BIND sets the listen address.
  if (process.env.VMP_PORT !== undefined) {
    const p = Number(process.env.VMP_PORT);
    if (Number.isInteger(p) && p >= 0 && p < 65536) config.port = p;
  }
  if (process.env.VMP_BIND) config.bind = process.env.VMP_BIND;
  // Server-to-server API token + iframe-embed origins are commonly injected by
  // the deploy environment (and integration tests) rather than config.json.
  if (process.env.VMP_PANEL_API_TOKEN && VALIDATORS.panelApiToken(process.env.VMP_PANEL_API_TOKEN)) {
    config.panelApiToken = process.env.VMP_PANEL_API_TOKEN;
  }
  if (process.env.VMP_EMBED_ORIGINS) {
    const origins = process.env.VMP_EMBED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    if (VALIDATORS.embedOrigins(origins)) config.embedOrigins = origins;
  }
  return config;
}
