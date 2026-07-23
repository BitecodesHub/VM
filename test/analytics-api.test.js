import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnPanel, setupAdmin } from './helpers/spawn-panel.js';

async function withPanel(fn) {
  const panel = await spawnPanel({});
  try { await fn(panel); } finally { panel.kill(); }
}

// Append a closed session row into the same JSONL the running server writes to.
function seed(panel, row) {
  fs.appendFileSync(path.join(panel.dataDir, 'usage-sessions.jsonl'), JSON.stringify(row) + '\n');
}

test('GET /api/analytics: admin-gated, correct shape, reflects the ledger', async () => {
  await withPanel(async (panel) => {
    const admin = await setupAdmin(panel);

    // Unauthenticated is rejected once an admin exists (before setup it's 409).
    assert.equal((await panel.req('GET', '/api/analytics')).status, 401, 'no cookie → 401');

    // Empty ledger: zeroed totals, 30-day zero-filled series.
    const empty = await panel.req('GET', '/api/analytics', { cookie: admin });
    assert.equal(empty.status, 200);
    assert.equal(empty.json.totals.sessions, 0);
    assert.equal(empty.json.byUser.length, 0);
    assert.equal(empty.json.daily.length, 30);

    // Seed two recent sessions, then confirm the live route aggregates them.
    const now = Date.now();
    seed(panel, { id: '1', user: 'alice', machine: 'desk-1', template: 'linux-desktop', owner: 'bob',
      startedAt: new Date(now - 3_600_000).toISOString(), endedAt: new Date(now - 1_800_000).toISOString(),
      durationSec: 1800, endedReason: 'disconnect', ip: null });
    seed(panel, { id: '2', user: 'alice', machine: 'desk-1', template: 'linux-desktop', owner: 'bob',
      startedAt: new Date(now - 1_200_000).toISOString(), endedAt: new Date(now - 600_000).toISOString(),
      durationSec: 600, endedReason: 'disconnect', ip: null });

    const r = await panel.req('GET', '/api/analytics?days=7', { cookie: admin });
    assert.equal(r.status, 200);
    assert.equal(r.json.range.days, 7);
    assert.equal(r.json.daily.length, 7);
    assert.equal(r.json.totals.sessions, 2);
    assert.equal(r.json.totals.users, 1);
    assert.equal(r.json.totals.machines, 1);
    assert.equal(r.json.byUser[0].user, 'alice');
    assert.equal(r.json.byUser[0].seconds, 2400);
    assert.equal(r.json.byMachine[0].machine, 'desk-1');
    assert.equal(r.json.byMachine[0].owner, 'bob');
  });
});
