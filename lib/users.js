// UserStore — file-backed user database for VM Panel.
// Usernames are lowercase (validated by core.validateUsername at the API layer).

import { loadJsonFile, atomicWriteJson } from './store.js';
import { hashPassword, verifyPassword, DUMMY_RECORD } from './auth.js';

export class UserStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.users = new Map();
  }

  load() {
    const data = loadJsonFile(this.filePath, { version: 1, users: {} });
    if (!data || typeof data.users !== 'object') {
      throw new Error(`Malformed user database at ${this.filePath}`);
    }
    this.users = new Map(Object.entries(data.users));
    return this;
  }

  async _persist() {
    await atomicWriteJson(this.filePath, {
      version: 1,
      users: Object.fromEntries(this.users),
    });
  }

  // Persist, and if the write fails (e.g. disk full) run `rollback` to undo the
  // in-memory change before rethrowing — so a 500 never leaves memory and disk
  // diverged (the change would otherwise silently vanish on the next restart).
  async _persistOrRollback(rollback) {
    try { await this._persist(); }
    catch (e) { try { rollback(); } catch { /* best effort */ } throw e; }
  }

  isEmpty() { return this.users.size === 0; }

  get(username) { return this.users.get(username) || null; }

  list() { return [...this.users.values()]; }

  // Public projection — never expose hash/salt.
  static publicUser(u) {
    return {
      username: u.username,
      role: u.role,
      disabled: u.disabled,
      mustChangePassword: u.mustChangePassword,
      createdAt: u.createdAt,
    };
  }

  async create({ username, password, role = 'user', mustChangePassword = true }) {
    if (this.users.has(username)) {
      const err = new Error('user exists');
      err.code = 'USER_EXISTS';
      throw err;
    }
    const cred = await hashPassword(password);
    // Guard the check-then-insert against interleaved awaits: re-check after hashing.
    if (this.users.has(username)) {
      const err = new Error('user exists');
      err.code = 'USER_EXISTS';
      throw err;
    }
    const user = {
      username,
      role,
      hash: cred.hash,
      salt: cred.salt,
      scrypt: cred.scrypt,
      disabled: false,
      mustChangePassword,
      createdAt: new Date().toISOString(),
      passwordChangedAt: null,
    };
    this.users.set(username, user);
    await this._persistOrRollback(() => this.users.delete(username));
    return user;
  }

  async setPassword(username, password, { mustChangePassword = false } = {}) {
    const user = this._require(username);
    const cred = await hashPassword(password);
    const prev = { hash: user.hash, salt: user.salt, scrypt: user.scrypt, mustChangePassword: user.mustChangePassword, passwordChangedAt: user.passwordChangedAt };
    user.hash = cred.hash;
    user.salt = cred.salt;
    user.scrypt = cred.scrypt;
    user.mustChangePassword = mustChangePassword;
    user.passwordChangedAt = new Date().toISOString();
    await this._persistOrRollback(() => Object.assign(user, prev));
    return user;
  }

  async setRole(username, role) {
    const user = this._require(username);
    const prev = user.role;
    user.role = role;
    await this._persistOrRollback(() => { user.role = prev; });
    return user;
  }

  async setDisabled(username, disabled) {
    const user = this._require(username);
    const prev = user.disabled;
    user.disabled = !!disabled;
    await this._persistOrRollback(() => { user.disabled = prev; });
    return user;
  }

  async remove(username) {
    const user = this._require(username);
    this.users.delete(username);
    await this._persistOrRollback(() => this.users.set(username, user));
  }

  // Constant-time-ish credential check: unknown users burn a scrypt derivation
  // against a dummy record so timing does not reveal existence. Disabled users
  // fail exactly like wrong passwords.
  async verifyCredentials(username, password) {
    const user = this.users.get(username);
    if (!user) {
      await verifyPassword(password, DUMMY_RECORD);
      return null;
    }
    const ok = await verifyPassword(password, user);
    if (!ok || user.disabled) return null;
    return user;
  }

  isLastActiveAdmin(username) {
    const admins = this.list().filter((u) => u.role === 'admin' && !u.disabled);
    return admins.length === 1 && admins[0].username === username;
  }

  _require(username) {
    const user = this.users.get(username);
    if (!user) {
      const err = new Error('user not found');
      err.code = 'USER_NOT_FOUND';
      throw err;
    }
    return user;
  }
}
