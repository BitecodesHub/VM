import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, DEFAULT_CONFIG } from '../lib/config.js';

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-cfg-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const quiet = { log: () => {} };

test('loadConfig: missing file → defaults (never throws)', () => {
  withDir((dir) => {
    const c = loadConfig(dir, quiet);
    assert.equal(c.port, DEFAULT_CONFIG.port);
    assert.equal(c.publicTls, false);
    assert.equal(c.sessionMaxDays, 30);
    assert.equal(c.maxRunningMachines, 0);
    assert.equal(c.actionRateLimit, 60);
  });
});

test('loadConfig: valid values are applied; invalid ones are ignored (kept at default)', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      publicTls: true, publicHost: 'panel.example', panelHttpsPort: 443,
      sessionMaxDays: 7, maxRunningMachines: 25, actionRateLimit: 100,
      port: 70000,          // out of range → ignored
      sessionIdleHours: -1, // negative → ignored
      bind: '',             // empty → ignored
    }));
    const c = loadConfig(dir, quiet);
    assert.equal(c.publicTls, true);
    assert.equal(c.publicHost, 'panel.example');
    assert.equal(c.panelHttpsPort, 443);
    assert.equal(c.sessionMaxDays, 7);
    assert.equal(c.maxRunningMachines, 25);
    assert.equal(c.actionRateLimit, 100);
    assert.equal(c.port, DEFAULT_CONFIG.port, 'out-of-range port rejected');
    assert.equal(c.sessionIdleHours, DEFAULT_CONFIG.sessionIdleHours, 'negative idle rejected');
    assert.equal(c.bind, DEFAULT_CONFIG.bind, 'empty bind rejected');
  });
});

test('loadConfig: malformed JSON → defaults (never throws)', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ not valid json');
    const c = loadConfig(dir, quiet);
    assert.equal(c.port, DEFAULT_CONFIG.port);
  });
});

test('loadConfig: env overrides always win (VMP_PORT accepts 0, VMP_BIND sets addr)', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 5050, bind: '127.0.0.1' }));
    const savedPort = process.env.VMP_PORT; const savedBind = process.env.VMP_BIND;
    try {
      process.env.VMP_PORT = '0';
      process.env.VMP_BIND = '::1';
      const c = loadConfig(dir, quiet);
      assert.equal(c.port, 0, 'VMP_PORT=0 honored for ephemeral binding');
      assert.equal(c.bind, '::1');
    } finally {
      if (savedPort === undefined) delete process.env.VMP_PORT; else process.env.VMP_PORT = savedPort;
      if (savedBind === undefined) delete process.env.VMP_BIND; else process.env.VMP_BIND = savedBind;
    }
  });
});
