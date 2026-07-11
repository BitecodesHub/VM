// UsageStore — lightweight machine-minutes accounting per owner (and per template).
// Sampled once a minute for every running panel machine; persisted debounced.
// Not billing-grade, but enough for capacity planning and chargeback reporting.

import { loadJsonFile, atomicWriteJson } from './store.js';

export class UsageStore {
  constructor(filePath, { flushDebounceMs = 30_000, now = Date.now } = {}) {
    this.filePath = filePath;
    this.flushDebounceMs = flushDebounceMs;
    this.now = now;
    this.owners = new Map();   // owner -> { minutes, byTemplate: {t: minutes}, lastAt }
    this._timer = null;
    this._dirty = false;
  }

  load() {
    const data = loadJsonFile(this.filePath, { version: 1, owners: {} });
    this.owners = new Map(Object.entries(data.owners || {}));
    return this;
  }

  // Add `mins` machine-minutes to an owner for a template.
  add(owner, template, mins = 1) {
    if (!owner) return;
    const e = this.owners.get(owner) || { minutes: 0, byTemplate: {}, lastAt: null };
    e.minutes += mins;
    e.byTemplate[template] = (e.byTemplate[template] || 0) + mins;
    e.lastAt = new Date(this.now()).toISOString();
    this.owners.set(owner, e);
    this._scheduleFlush();
  }

  // Report: [{ owner, minutes, hours, byTemplate, lastAt }] sorted by minutes desc.
  summary() {
    return [...this.owners.entries()]
      .map(([owner, e]) => ({ owner, minutes: e.minutes, hours: Math.round((e.minutes / 60) * 10) / 10, byTemplate: e.byTemplate, lastAt: e.lastAt }))
      .sort((a, b) => b.minutes - a.minutes);
  }

  _scheduleFlush() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; if (this._dirty) this._persist().catch(() => {}); }, this.flushDebounceMs);
    this._timer.unref?.();
  }
  async flush() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } if (this._dirty) await this._persist(); }
  async _persist() {
    this._dirty = false;
    await atomicWriteJson(this.filePath, { version: 1, owners: Object.fromEntries(this.owners) });
  }
}
