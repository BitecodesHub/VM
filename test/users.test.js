import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserStore } from '../lib/users.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-users-'));
  return { store: new UserStore(path.join(dir, 'users.json')).load(), dir };
}

test('create, duplicate rejection, list, publicUser hides secrets', async () => {
  const { store } = tmpStore();
  assert.equal(store.isEmpty(), true);
  const u = await store.create({ username: 'alice', password: 'password-alice', role: 'admin', mustChangePassword: false });
  assert.equal(u.role, 'admin');
  assert.equal(store.isEmpty(), false);
  await assert.rejects(store.create({ username: 'alice', password: 'whatever-pw' }), (e) => e.code === 'USER_EXISTS');
  const pub = UserStore.publicUser(store.get('alice'));
  assert.ok(!('hash' in pub) && !('salt' in pub));
});

test('verifyCredentials: correct, wrong, unknown (dummy path), disabled', async () => {
  const { store } = tmpStore();
  await store.create({ username: 'bob', password: 'bob-password1' });
  assert.ok(await store.verifyCredentials('bob', 'bob-password1'));
  assert.equal(await store.verifyCredentials('bob', 'wrong-password'), null);
  assert.equal(await store.verifyCredentials('nobody', 'whatever-pw1'), null);
  await store.setDisabled('bob', true);
  assert.equal(await store.verifyCredentials('bob', 'bob-password1'), null);
});

test('setPassword invalidates old credential and sets flags', async () => {
  const { store } = tmpStore();
  await store.create({ username: 'carol', password: 'carol-first-pw' });
  await store.setPassword('carol', 'carol-second-pw', { mustChangePassword: true });
  assert.equal(await store.verifyCredentials('carol', 'carol-first-pw'), null);
  const u = await store.verifyCredentials('carol', 'carol-second-pw');
  assert.ok(u);
  assert.equal(u.mustChangePassword, true);
});

test('isLastActiveAdmin and role changes', async () => {
  const { store } = tmpStore();
  await store.create({ username: 'root', password: 'root-password', role: 'admin' });
  await store.create({ username: 'dave', password: 'dave-password' });
  assert.equal(store.isLastActiveAdmin('root'), true);
  await store.setRole('dave', 'admin');
  assert.equal(store.isLastActiveAdmin('root'), false);
  await store.setDisabled('dave', true);
  assert.equal(store.isLastActiveAdmin('root'), true);
});

test('remove deletes; persistence survives reload; file mode 0600', async () => {
  const { store } = tmpStore();
  await store.create({ username: 'eve', password: 'eve-password1' });
  await store.remove('eve');
  assert.equal(store.get('eve'), null);
  await store.create({ username: 'frank', password: 'frank-password' });
  const reloaded = new UserStore(store.filePath).load();
  assert.ok(reloaded.get('frank'));
  const mode = fs.statSync(store.filePath).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('corrupt users.json fails loudly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-users-'));
  const file = path.join(dir, 'users.json');
  fs.writeFileSync(file, '{not json');
  assert.throws(() => new UserStore(file).load(), /Corrupt JSON/);
});
