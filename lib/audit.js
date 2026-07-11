// Append-only audit trail for privileged / security-relevant actions.
// One JSON object per line (JSONL): { ts, actor, action, target, detail, ip }.
// Best-effort and self-bounding — recording never throws into a request path,
// and the file is trimmed to the newest `maxEntries` so it cannot grow forever.

import fs from 'node:fs';

export class AuditLog {
  constructor(filePath, { maxEntries = 5000, trimEvery = 250, now = Date.now } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.trimEvery = trimEvery;
    this.now = now;
    this._sinceTrim = 0;
  }

  record({ actor = null, action, target = null, detail = null, ip = null }) {
    if (!action) return;
    const entry = { ts: new Date(this.now()).toISOString(), actor, action, target, detail, ip: ip ? String(ip).slice(0, 64) : null };
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
      if (++this._sinceTrim >= this.trimEvery) { this._sinceTrim = 0; this._trim(); }
    } catch { /* auditing must never break the action it records */ }
  }

  // Keep only the newest maxEntries lines (bounds unbounded growth).
  _trim() {
    try {
      const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= this.maxEntries) return;
      fs.writeFileSync(this.filePath, lines.slice(-this.maxEntries).join('\n') + '\n');
    } catch { /* ignore */ }
  }

  // Newest-first, most recent `limit` entries. Skips corrupt lines.
  list({ limit = 200 } = {}) {
    let lines;
    try { lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean); }
    catch { return []; }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* skip corrupt */ }
    }
    return out;
  }
}
