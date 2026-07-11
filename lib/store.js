// Atomic JSON file persistence for VM Panel data stores.
// All files live under data/ (0700); every file is written 0600 via tmp+fsync+rename.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Per-path single-writer queues so concurrent mutations cannot interleave.
const writeQueues = new Map();

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
    const tmpPath = `${filePath}.tmp`;
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
