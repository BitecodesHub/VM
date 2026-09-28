// Desktop time zone: the ~/.bashrc hook and the write script run for real
// (bash/sh against a temp home, with the host's zoneinfo), and the ext API
// flow runs against the fake docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  TZ_HOOK, TZ_HOOK_MARK, TZ_FILE, TZ_READ_SCRIPT, TZ_WRITE_SCRIPT,
  validTimeZoneName, parseZoneTab, supportsDesktopTimezone, availableTemplates, listTemplates,
} from '../lib/core.js';
import { spawnPanel, setupAdmin } from './helpers/spawn-panel.js';

const TOKEN = 'prism-ext-token-abcdefghijklmnop';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const HAS_ZONEINFO = fs.existsSync('/usr/share/zoneinfo/Asia/Manila');

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-tz-')); }

// What vnc_startup.sh does: `set -e`, then `source ~/.bashrc`, then start the session.
function sessionTz(home) {
  const r = spawnSync('bash', ['-c', 'set -e; source "$HOME/.bashrc"; echo "TZ=${TZ-unset}"; echo started'], { env: { HOME: home, PATH: process.env.PATH, TZ: 'Etc/UTC' }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout };
}

function writeTz(home, tz) {
  return spawnSync('sh', ['-c', TZ_WRITE_SCRIPT], { env: { PATH: process.env.PATH, PRISM_HOME: home, PRISM_TZ: tz, PRISM_TZ_MARK: TZ_HOOK_MARK, PRISM_TZ_HOOK: TZ_HOOK }, encoding: 'utf8' });
}

test('time zone names: shape only, no traversal', () => {
  for (const ok of ['UTC', 'Asia/Manila', 'Asia/Kolkata', 'America/Argentina/Buenos_Aires', 'Etc/GMT+10']) assert.ok(validTimeZoneName(ok), ok);
  for (const bad of ['', '../etc/passwd', 'Asia/../../x', '/etc/localtime', 'Asia/Manila;rm -rf /', 'a'.repeat(70), 'Asia/Manila\nUTC', null, 42]) assert.ok(!validTimeZoneName(bad), String(bad));
});

test('zone.tab parsing: UTC first, sorted, unique, comments skipped', () => {
  const zones = parseZoneTab('# c\nPH\t+1\tAsia/Manila\nIN\t+2\tAsia/Kolkata\nAU\t-3\tAustralia/Sydney\tNSW\nPH\t+1\tAsia/Manila\n\nbad line\n');
  assert.deepEqual(zones, ['UTC', 'Asia/Kolkata', 'Asia/Manila', 'Australia/Sydney']);
});

test('only the KasmVNC desktops take a time zone; browser-node templates are withdrawn', () => {
  assert.equal(supportsDesktopTimezone('linux-desktop'), true);
  assert.equal(supportsDesktopTimezone('icewm-desktop'), true);
  assert.equal(supportsDesktopTimezone('chrome-node'), false);
  assert.equal(supportsDesktopTimezone('nope'), false);
  assert.deepEqual(availableTemplates().map((t) => t.id).sort(), ['icewm-desktop', 'linux-desktop']);
  assert.ok(listTemplates().find((t) => t.id === 'chrome-node').withdrawn, 'still listed, flagged');
});

test('hook under set -e: a missing, empty or hostile file never stops the session', { skip: !HAS_ZONEINFO && 'no zoneinfo' }, () => {
  const home = tmpHome();
  try {
    fs.writeFileSync(path.join(home, '.bashrc'), 'true\n' + TZ_HOOK + '\n');
    let r = sessionTz(home);
    assert.equal(r.code, 0); assert.match(r.out, /TZ=Etc\/UTC\nstarted/, 'no file: image default kept');
    fs.mkdirSync(path.join(home, path.dirname(TZ_FILE)), { recursive: true });
    for (const [content, expect] of [
      ['', 'Etc/UTC'],
      ['Mars/Olympus\n', 'Etc/UTC'],
      ['../../../etc/passwd\n', 'Etc/UTC'],
      ['Asia/Manila; touch /tmp/pwned\n', 'Etc/UTC'],
      ['Asia/Manila\n', 'Asia/Manila'],
      ['Australia/Sydney\nextra\n', 'Australia/Sydney'],
    ]) {
      fs.writeFileSync(path.join(home, TZ_FILE), content);
      r = sessionTz(home);
      assert.equal(r.code, 0, `exit 0 for ${JSON.stringify(content)}`);
      assert.match(r.out, new RegExp(`TZ=${expect.replace('/', '\\/')}\\nstarted`), JSON.stringify(content));
    }
    fs.chmodSync(path.join(home, TZ_FILE), 0o000);
    if (process.getuid?.() !== 0) { r = sessionTz(home); assert.equal(r.code, 0, 'unreadable file'); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('write script: saves the zone, installs the hook once, refuses an unknown zone', { skip: !HAS_ZONEINFO && 'no zoneinfo' }, () => {
  const home = tmpHome();
  try {
    fs.writeFileSync(path.join(home, '.bashrc'), 'source $STARTUPDIR/generate_container_user\n');
    assert.equal(writeTz(home, 'Asia/Manila').status, 0);
    assert.equal(fs.readFileSync(path.join(home, TZ_FILE), 'utf8'), 'Asia/Manila\n');
    assert.equal(writeTz(home, 'Asia/Kolkata').status, 0);
    const rc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
    assert.equal(rc.split(TZ_HOOK_MARK).length - 1, 1, 'hook appended exactly once');
    assert.ok(rc.startsWith('source $STARTUPDIR/generate_container_user\n'), 'existing .bashrc kept');
    assert.equal(writeTz(home, 'Mars/Olympus').status, 3, 'unknown zone');
    assert.equal(fs.readFileSync(path.join(home, TZ_FILE), 'utf8'), 'Asia/Kolkata\n', 'unchanged after a refusal');
    assert.ok(!fs.existsSync(path.join(home, `${TZ_FILE}.tmp`)));
    // End to end: the session now starts in the saved zone.
    fs.writeFileSync(path.join(home, '.bashrc'), rc.replace('source $STARTUPDIR/generate_container_user\n', ''));
    assert.match(sessionTz(home).out, /TZ=Asia\/Kolkata\nstarted/);
    // A home with no .bashrc yet gets one holding just the hook.
    const bare = tmpHome();
    try { assert.equal(writeTz(bare, 'UTC').status, 0); assert.ok(fs.readFileSync(path.join(bare, '.bashrc'), 'utf8').includes(TZ_HOOK_MARK)); }
    finally { fs.rmSync(bare, { recursive: true, force: true }); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('read script: reports the saved zone (and no active one off Linux)', { skip: !HAS_ZONEINFO && 'no zoneinfo' }, () => {
  const home = tmpHome();
  try {
    let out = execFileSync('sh', ['-c', TZ_READ_SCRIPT], { env: { PATH: process.env.PATH, PRISM_HOME: home }, encoding: 'utf8' });
    assert.match(out, /^saved=\n/);
    writeTz(home, 'Asia/Manila');
    out = execFileSync('sh', ['-c', TZ_READ_SCRIPT], { env: { PATH: process.env.PATH, PRISM_HOME: home }, encoding: 'utf8' });
    assert.match(out, /^saved=Asia\/Manila\nactive=.*\n$/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('ext: desktop time zone read, set (restarts), pending, refusals, withdrawn templates', async () => {
  const node = { id: 'n1', image: 'local-seleniarm/standalone-chromium:4.5.0-20260701', state: 'running', labels: { 'vmpanel.managed': '1', 'vmpanel.template': 'chrome-node', 'vmpanel.owner': 'admin', 'vmpanel.ui.port': '7901' } };
  const panel = await spawnPanel({ env: { VMP_PANEL_API_TOKEN: TOKEN }, world: { nextId: 5, containers: { 'chrome-node-1': node } } });
  try {
    const admin = await setupAdmin(panel);
    // No new browser nodes; the listing PRISM shows leaves them out.
    const refused = await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'chrome-node', name: 'cn-2' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.error.code, 'TEMPLATE_WITHDRAWN');
    const tpl = await panel.req('GET', '/api/ext/templates', { headers: AUTH });
    assert.deepEqual(tpl.json.templates.map((t) => t.id).sort(), ['icewm-desktop', 'linux-desktop']);

    const made = await panel.req('POST', '/api/machines', { cookie: admin, body: { template: 'linux-desktop', name: 'tz-desk' } });
    assert.equal(made.status, 202);
    let world;
    for (let i = 0; i < 50; i++) { try { world = panel.readWorld(); } catch { world = null; } if (world?.containers['tz-desk']?.state === 'running') break; await new Promise((r) => setTimeout(r, 100)); }

    const url = '/api/ext/machines/tz-desk/timezone';
    let r = await panel.req('GET', url, { headers: AUTH });
    assert.equal(r.status, 200);
    assert.equal(r.json.timeZone, 'UTC');
    assert.equal(r.json.activeTimeZone, 'UTC');
    assert.equal(r.json.pendingRestart, false);
    assert.equal(r.json.zones[0], 'UTC');
    assert.ok(r.json.zones.includes('Asia/Manila'));

    r = await panel.req('PUT', url, { headers: AUTH, body: { timeZone: 'Asia/Manila', actor: 'alice@example.com' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.restarted, true);
    r = await panel.req('GET', url, { headers: AUTH });
    assert.equal(r.json.timeZone, 'Asia/Manila');
    assert.equal(r.json.activeTimeZone, 'Asia/Manila', 'the restarted session uses it');
    assert.equal(r.json.pendingRestart, false);

    r = await panel.req('PUT', url, { headers: AUTH, body: { timeZone: 'Asia/Kolkata', restart: false } });
    assert.equal(r.json.restarted, false);
    r = await panel.req('GET', url, { headers: AUTH });
    assert.equal(r.json.timeZone, 'Asia/Kolkata');
    assert.equal(r.json.pendingRestart, true, 'saved but not applied yet');

    assert.equal((await panel.req('PUT', url, { headers: AUTH, body: { timeZone: 'Mars/Olympus' } })).json.error.code, 'UNKNOWN_TIME_ZONE');
    assert.equal((await panel.req('PUT', url, { headers: AUTH, body: { timeZone: '../../etc/passwd' } })).json.error.code, 'VALIDATION');
    assert.equal((await panel.req('GET', '/api/ext/machines/chrome-node-1/timezone', { headers: AUTH })).json.error.code, 'UNSUPPORTED');
    assert.equal((await panel.req('GET', '/api/ext/machines/ghost/timezone', { headers: AUTH })).status, 404);
    assert.equal((await panel.req('GET', url)).status, 401, 'bearer required');

    await panel.req('POST', '/api/ext/machines/tz-desk/action', { headers: AUTH, body: { action: 'stop' } });
    r = await panel.req('GET', url, { headers: AUTH });
    assert.equal(r.json.running, false);
    assert.equal((await panel.req('PUT', url, { headers: AUTH, body: { timeZone: 'UTC' } })).json.error.code, 'NOT_RUNNING');

    const audit = await panel.req('GET', '/api/ext/audit?limit=50', { headers: AUTH });
    const tzEvents = (audit.json.entries || audit.json.events || []).filter((e) => e.action === 'machine.timezone');
    assert.ok(tzEvents.length >= 2, 'audited');
  } finally { panel.kill(); }
});
