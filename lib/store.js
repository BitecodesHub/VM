// Atomic JSON file persistence for VM Panel data stores.
// All files live under data/ (0700); every file is written 0600 via tmp+fsync+rename.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Per-path single-writer queues so concurrent mutations cannot interleave.
const writeQueues = new Map();

// Distinguishes temp files from different processes (pids are reused).
const TMP_NONCE = crypto.randomBytes(4).toString('hex');

export function ensureDataDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dirPath, 0o700); } catch { /* best effort */ }
  return dirPath;
}

// Load a JSON file. Missing file -> fallback. Corrupt JSON -> throw loudly
// (never silently reset a user database).
export function loadJsonFile(filePath, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt JSON in ${filePath} — refusing to start. Fix or remove the file.`);
  }
}

// Atomic write: serialize -> tmp file (0600) -> write -> fsync -> rename -> dir fsync.
// Serialized per path through a promise chain.
export function atomicWriteJson(filePath, obj, mode = 0o600) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const next = prev.then(async () => {
    const data = JSON.stringify(obj, null, 2);
    // Process-unique temp name. The write queue above serialises writers WITHIN
    // one process; a fixed `${filePath}.tmp` meant two processes sharing the data
    // directory could interleave open/write/rename on the same temp path and
    // publish a torn or foreign payload as users.json. With a per-process suffix
    // the worst case degrades to last-writer-wins on the rename, which is
    // atomic — and acquireInstanceLock() should prevent that case entirely.
    const tmpPath = `${filePath}.${process.pid}.${TMP_NONCE}.tmp`;
    const fh = await fsp.open(tmpPath, 'w', mode);
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmpPath, filePath);
    // Best-effort directory fsync so the rename itself is durable.
    try {
      const dh = await fsp.open(path.dirname(filePath), 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch { /* not fatal */ }
  });
  // Keep the chain alive even if a write fails; surface the error to this caller only.
  writeQueues.set(filePath, next.catch(() => {}));
  return next;
}

// ---- Single-instance lock ---------------------------------------------------
// Two panels sharing one data directory is silently destructive: each holds the
// authoritative copy of users/sessions/shares in memory and rewrites the WHOLE
// file on every mutation, so they clobber each other last-writer-wins (accounts
// and share ACLs simply vanish). Quotas, the socket ceiling and the SSO
// single-use replay guard are also per-process, so a second instance doubles
// every limit and makes a live SSO token redeemable twice.
//
// O_EXCL create is the lock. A stale lock from a crashed process is detected by
// probing the recorded pid rather than by age, so a restart is never blocked by
// a leftover file, and a LIVE instance is never stolen from.
// The kernel's per-boot id (Linux). A lock written under a different boot id was
// left by a process that no longer exists, whatever its pid says now.
export function readBootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch { return null; }
}

// Is `pid` a VM Panel process? true / false on Linux (/proc/<pid>/cmdline is
// world-readable), null where that cannot be told (macOS) — callers then fall
// back to "any live pid is a holder".
export function isPanelProcess(pid) {
  let cmd;
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (e) { return e.code === 'ENOENT' && fs.existsSync('/proc/self') ? false : null; }
  return /(^|[\/\0])server\.js(\0|$)/.test(cmd);
}

export function acquireInstanceLock(dirPath, { pid = process.pid, bootId = readBootId(), isPanel = isPanelProcess } = {}) {
  const lockPath = path.join(dirPath, 'panel.lock');
  const write = () => fs.writeFileSync(lockPath, JSON.stringify({ pid, bootId, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  try {
    write();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* unreadable => treat as stale */ }
    const otherPid = Number(holder?.pid);
    // A lock that survived a reboot or a snapshot restore names a pid from a
    // previous boot. After boot that number is often reused by an unrelated
    // (frequently root-owned, so EPERM) process, which used to read as "alive"
    // and left the panel refusing to start in a systemd restart loop.
    const sameBoot = !(holder?.bootId && bootId && holder.bootId !== bootId);
    if (sameBoot && Number.isInteger(otherPid) && otherPid > 0 && otherPid !== pid) {
      // Signal 0 tests for existence without delivering anything. EPERM means the
      // process exists but is owned by another user — still alive, still a holder.
      let alive = false;
      try { process.kill(otherPid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
      // Alive only counts if it is actually a panel (where the OS lets us check).
      if (alive && isPanel(otherPid) !== false) {
        const err = new Error(`Another VM Panel instance (pid ${otherPid}) is already using ${dirPath}. Refusing to start: two instances corrupt the data directory. Stop the other instance, or remove ${lockPath} if you are certain it is gone.`);
        err.code = 'VMP_LOCKED';
        throw err;
      }
    }
    // Stale lock — reclaim it.
    fs.rmSync(lockPath, { force: true });
    write();
  }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      // Only remove the lock if it is still OURS (a reclaim race could mean it is not).
      try {
        const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (Number(cur?.pid) !== pid) return;
      } catch { return; }
      try { fs.rmSync(lockPath, { force: true }); } catch { /* best effort */ }
    },
  };
}

// Read or create the HMAC secret (32 random bytes, hex, 0600).
// Rotating/deleting this file invalidates every session cookie.
export function ensureSecret(filePath) {
  try {
    const hex = fs.readFileSync(filePath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    throw new Error(`Malformed secret file ${filePath} — remove it to regenerate (logs everyone out).`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(filePath, secret.toString('hex') + '\n', { mode: 0o600 });
  return secret;
}
