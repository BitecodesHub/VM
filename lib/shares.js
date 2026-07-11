// Per-machine access lists (sharing). Docker labels are immutable, so sharing
// lives here in data/machines.json. Keyed by container NAME (the panel's sole
// identity). Write-through persistence (grants are rare; durability matters).

import { loadJsonFile, atomicWriteJson } from './store.js';

export class ShareStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.machines = new Map(); // name -> { sharedWith: string[], updatedAt }
  }

  load() {
    const data = loadJsonFile(this.filePath, { version: 1, machines: {} });
    if (!data || typeof data.machines !== 'object') {
      throw new Error(`Malformed shares file at ${this.filePath}`);
    }
    this.machines = new Map(Object.entries(data.machines));
    return this;
  }

  async _persist() {
    await atomicWriteJson(this.filePath, { version: 1, machines: Object.fromEntries(this.machines) });
  }

  // Deep-ish clone of the current map for rollback (entries + sharedWith arrays).
  _snapshot() {
    return new Map([...this.machines].map(([k, v]) => [k, { sharedWith: [...v.sharedWith], updatedAt: v.updatedAt }]));
  }
  // Persist; on failure restore the pre-mutation map so memory matches disk.
  async _persistOrRollback(snapshot) {
    try { await this._persist(); }
    catch (e) { this.machines = snapshot; throw e; }
  }

  // Sorted copy of the usernames a machine is shared with ([] if none).
  listFor(name) {
    const e = this.machines.get(name);
    return e ? [...e.sharedWith].sort() : [];
  }

  // Set of machine names shared with a given user.
  sharedWithUser(username) {
    const out = new Set();
    for (const [name, e] of this.machines) if (e.sharedWith.includes(username)) out.add(name);
    return out;
  }

  isSharedWith(name, username) {
    return !!this.machines.get(name)?.sharedWith.includes(username);
  }

  async grant(name, username) {
    const e = this.machines.get(name) || { sharedWith: [], updatedAt: null };
    if (!e.sharedWith.includes(username)) {
      const snap = this._snapshot();
      e.sharedWith = [...e.sharedWith, username];
      e.updatedAt = new Date().toISOString();
      this.machines.set(name, e);
      await this._persistOrRollback(snap);
    }
  }

  async revoke(name, username) {
    const e = this.machines.get(name);
    if (!e || !e.sharedWith.includes(username)) return;
    const snap = this._snapshot();
    e.sharedWith = e.sharedWith.filter((u) => u !== username);
    if (e.sharedWith.length === 0) this.machines.delete(name);
    else { e.updatedAt = new Date().toISOString(); this.machines.set(name, e); }
    await this._persistOrRollback(snap);
  }

  // Full replace (PUT semantics). Dedupes; deletes the key when empty.
  async setList(name, usernames) {
    const deduped = [...new Set(usernames)];
    const snap = this._snapshot();
    if (deduped.length === 0) this.machines.delete(name);
    else this.machines.set(name, { sharedWith: deduped, updatedAt: new Date().toISOString() });
    await this._persistOrRollback(snap);
    return deduped.sort();
  }

  // Lifecycle: a machine was deleted.
  async removeMachine(name) {
    if (!this.machines.has(name)) return;
    const snap = this._snapshot();
    this.machines.delete(name);
    await this._persistOrRollback(snap);
  }

  // Lifecycle: a user was deleted — scrub them from every list.
  async removeUser(username) {
    const snap = this._snapshot();
    let changed = false;
    for (const [name, e] of this.machines) {
      if (e.sharedWith.includes(username)) {
        e.sharedWith = e.sharedWith.filter((u) => u !== username);
        if (e.sharedWith.length === 0) this.machines.delete(name);
        changed = true;
      }
    }
    if (changed) await this._persistOrRollback(snap);
  }

  // Drop entries whose machine no longer exists. `liveNames` is a Set.
  // ONLY call with a trustworthy live set (never from stale/empty state).
  async sweep(liveNames) {
    const snap = this._snapshot();
    let changed = false;
    for (const name of this.machines.keys()) {
      if (!liveNames.has(name)) { this.machines.delete(name); changed = true; }
    }
    if (changed) await this._persistOrRollback(snap);
  }
}
