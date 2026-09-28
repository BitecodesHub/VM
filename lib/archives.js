// Deleted-desktop archives: a restorable copy of a desktop's home directory,
// kept for a retention window after the machine is deleted.
//
// A desktop's files live in the container's writable layer (no volumes), so
// deleting the container destroyed them outright; the only way back was a
// whole-host EBS snapshot, losing up to a day of everyone's work. Deleting
// through the ext API now archives the home directory first and only removes
// the container once the archive is safely on disk.
//
// Layout (inside the data dir, which is 0700 and never committed):
//   archives/index.json          metadata, one entry per archive
//   archives/<id>.tar.gz         the gzipped `docker cp` tar of the home dir
//   archives/<id>.tar.gz.partial an archive still being written (never listed)
//
// The index is written only AFTER the archive file is complete, so a crash
// mid-archive leaves a .partial file that sweepOrphans() reclaims, never an
// index entry that points at a truncated file.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadJsonFile, atomicWriteJson } from './store.js';

export const ARCHIVE_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
const ID_RE = /^[a-f0-9]{16}$/;
// Unreferenced files younger than this may belong to an archive in progress.
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export function validArchiveId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// Fields a caller may see. The on-disk file name is derived from the id and is
// deliberately not part of the public shape.
function publicEntry(e) {
  return {
    id: e.id,
    machine: e.machine,
    displayName: e.displayName ?? null,
    template: e.template,
    owner: e.owner ?? null,
    sharedWith: Array.isArray(e.sharedWith) ? e.sharedWith : [],
    homeDir: e.homeDir,
    bytes: e.bytes,
    deletedAt: e.deletedAt,
    deletedBy: e.deletedBy ?? null,
    expiresAt: e.expiresAt,
    ref: e.ref ?? null,
    limits: e.limits ?? null,
  };
}

// An opaque caller reference (PRISM keys its assignment snapshot by it).
export function validArchiveRef(ref) {
  return typeof ref === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ref);
}

export class ArchiveStore {
  constructor(dir, { now = () => Date.now(), retentionDays = ARCHIVE_RETENTION_DAYS } = {}) {
    this.dir = dir;
    this.indexPath = path.join(dir, 'index.json');
    this.now = now;
    this.retentionMs = retentionDays * DAY_MS;
    this.entries = new Map(); // id -> entry
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* best effort */ }
    const data = loadJsonFile(this.indexPath, { version: 1, archives: {} });
    if (!data || typeof data.archives !== 'object') throw new Error(`Malformed archive index at ${this.indexPath}`);
    this.entries = new Map(Object.entries(data.archives).filter(([id]) => validArchiveId(id)));
    return this;
  }

  newId() { return crypto.randomBytes(8).toString('hex'); }
  fileFor(id) { return path.join(this.dir, `${id}.tar.gz`); }
  partialFor(id) { return `${this.fileFor(id)}.partial`; }

  async _persist() {
    await atomicWriteJson(this.indexPath, { version: 1, archives: Object.fromEntries(this.entries) });
  }

  list() {
    return [...this.entries.values()]
      .sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))
      .map(publicEntry);
  }

  get(id) {
    const e = validArchiveId(id) ? this.entries.get(id) : null;
    return e ? publicEntry(e) : null;
  }

  isExpired(id) {
    const e = this.entries.get(id);
    return !e || Date.parse(e.expiresAt) <= this.now();
  }

  // Record a COMPLETE archive. The caller has already renamed the .partial file
  // to fileFor(id); the entry is only visible once that file exists.
  async add({ id, machine, displayName, template, owner, sharedWith, homeDir, bytes, deletedBy, ref, limits = null }) {
    if (!validArchiveId(id)) throw new Error('invalid archive id');
    if (!fs.existsSync(this.fileFor(id))) throw new Error('archive file missing');
    const at = this.now();
    const entry = {
      id, machine, displayName: displayName || null, template, owner: owner || null,
      sharedWith: Array.isArray(sharedWith) ? sharedWith : [], homeDir, bytes,
      deletedAt: new Date(at).toISOString(), deletedBy: deletedBy || null,
      expiresAt: new Date(at + this.retentionMs).toISOString(),
      ref: validArchiveRef(ref) ? ref : null,
      // The desktop's vCPU/memory limits, so a restore brings it back the same size.
      limits: limits && Number(limits.cpus) > 0 && Number(limits.memoryMiB) > 0 ? { cpus: Number(limits.cpus), memoryMiB: Number(limits.memoryMiB) } : null,
    };
    this.entries.set(id, entry);
    try { await this._persist(); }
    catch (e) { this.entries.delete(id); throw e; }
    return publicEntry(entry);
  }

  // Remove an archive (restored or purged). Index first, then the file, so a
  // failure never leaves an entry pointing at a deleted file.
  async remove(id) {
    if (!this.entries.has(id)) return false;
    const prev = this.entries.get(id);
    this.entries.delete(id);
    try { await this._persist(); }
    catch (e) { this.entries.set(id, prev); throw e; }
    try { fs.unlinkSync(this.fileFor(id)); } catch { /* already gone */ }
    return true;
  }

  async purgeExpired() {
    const removed = [];
    for (const id of [...this.entries.keys()]) {
      if (this.isExpired(id) && await this.remove(id)) removed.push(id);
    }
    return removed;
  }

  // Delete files the index does not reference (a crashed archive job's
  // .partial, or a file whose entry was removed but whose unlink failed).
  sweepOrphans() {
    const removed = [];
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return removed; }
    const cutoff = this.now() - ORPHAN_GRACE_MS;
    for (const name of names) {
      const m = name.match(/^([a-f0-9]{16})\.tar\.gz(\.partial)?$/);
      if (!m || (this.entries.has(m[1]) && !m[2])) continue;
      const p = path.join(this.dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed.push(name); }
      } catch { /* vanished */ }
    }
    return removed;
  }

  totalBytes() {
    let n = 0;
    for (const e of this.entries.values()) n += Number(e.bytes) || 0;
    return n;
  }
}
