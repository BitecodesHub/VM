import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP = path.join(ROOT, 'launchers', 'backup.sh');
const RESTORE = path.join(ROOT, 'launchers', 'restore.sh');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function seedData(dir) {
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ version: 1, users: { admin: { role: 'admin' } } }));
  fs.writeFileSync(path.join(dir, 'secret'), 'super-secret-hmac-key');
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({ version: 1, points: [{ vmRunning: true }] }));
  fs.writeFileSync(path.join(dir, 'alerts.jsonl'), '{"id":"disk","at":1}\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 5050 }));
}

test('backup.sh: archives all durable state (incl. metrics + alerts) and stamps last-backup', () => {
  const dataDir = tmp('vmp-bkdata-');
  const backupDir = tmp('vmp-bkout-');
  try {
    seedData(dataDir);
    execFileSync('bash', [BACKUP], { env: { ...process.env, VMP_DATA_DIR: dataDir, VMP_BACKUP_DIR: backupDir }, stdio: 'pipe' });

    const archives = fs.readdirSync(backupDir).filter((f) => f.endsWith('.tar.gz'));
    assert.equal(archives.length, 1, 'one archive written');
    assert.ok(fs.existsSync(path.join(dataDir, 'last-backup')), 'last-backup stamp written on success');

    const listing = execFileSync('tar', ['-tzf', path.join(backupDir, archives[0])], { encoding: 'utf8' });
    for (const f of ['users.json', 'secret', 'metrics.json', 'alerts.jsonl', 'config.json']) {
      assert.match(listing, new RegExp(`(^|\\n)\\.?/?${f.replace('.', '\\.')}`), `${f} is in the archive`);
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});

test('restore.sh: round-trips the archive back into a data dir (keeps a rollback copy)', () => {
  const dataDir = tmp('vmp-rsdata-');
  const backupDir = tmp('vmp-rsout-');
  try {
    seedData(dataDir);
    execFileSync('bash', [BACKUP], { env: { ...process.env, VMP_DATA_DIR: dataDir, VMP_BACKUP_DIR: backupDir }, stdio: 'pipe' });

    // Corrupt/lose the live data, then restore.
    fs.writeFileSync(path.join(dataDir, 'users.json'), 'CORRUPTED');
    fs.rmSync(path.join(dataDir, 'metrics.json'));
    execFileSync('bash', [RESTORE], {
      env: { ...process.env, VMP_DATA_DIR: dataDir, VMP_BACKUP_DIR: backupDir },
      input: 'y\n', stdio: 'pipe',
    });

    const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
    assert.equal(users.users.admin.role, 'admin', 'users.json restored from backup');
    assert.ok(fs.existsSync(path.join(dataDir, 'metrics.json')), 'metrics.json restored');
    assert.equal(fs.readFileSync(path.join(dataDir, 'secret'), 'utf8'), 'super-secret-hmac-key', 'secret restored');
    // A rollback copy of the pre-restore state was kept.
    const parent = path.dirname(dataDir);
    const rollbacks = fs.readdirSync(parent).filter((d) => d.startsWith(path.basename(dataDir) + '.pre-restore_'));
    assert.ok(rollbacks.length >= 1, 'rollback copy kept');
    for (const rb of rollbacks) fs.rmSync(path.join(parent, rb), { recursive: true, force: true });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});
