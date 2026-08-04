/**
 * REAL end-to-end acceptance test — run this before shipping.
 *
 *   node launchers/e2e-real.mjs        # exit 0 = shippable
 *
 * The `node --test` suite covers logic against FAKE docker/colima shims, which is
 * fast and hermetic but cannot catch the class of failure that actually broke this
 * product: the Dockerfiles were rewritten from noVNC to KasmVNC, the tagged images
 * were never rebuilt, and every desktop became unopenable while the entire unit
 * suite stayed green. Only a real container proves the product works.
 *
 * This creates a genuine desktop through the panel's own API, asserts that every
 * hardening flag reached the container, waits for it to report healthy, and pulls
 * the live screen through the authenticated proxy.
 *
 * Requires: a running Docker/Colima and the template images present
 * (`bash launchers/verify-images.sh` must print IMAGES_OK first).
 *
 * Non-destructive: temp data dir, ephemeral ports, its own machine name, and the
 * container plus its network are removed in the finally block even on failure.
 * It never touches production data or existing machines.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = '/Users/mac/Desktop/VM';
const NODE = process.execPath;
const DOCKER = '/opt/homebrew/bin/docker';
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-e2e-'));
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  bind: '127.0.0.1', port: 0, capResources: true, maxRunningMachines: 6, accessLog: false,
}));

let proc = null, machineName = null;

function req(port, { method = 'GET', p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message, headers: {}, body: '' }));
    if (body) r.write(body); r.end();
  });
}
const J = (port, method, p, cookie, obj) => req(port, {
  method, p,
  headers: {
    'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
    ...(cookie ? { Cookie: cookie } : {}),
    ...(obj ? { 'Content-Length': Buffer.byteLength(JSON.stringify(obj)) } : {}),
  },
  body: obj ? JSON.stringify(obj) : null,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ---- boot the panel against REAL docker ----
  proc = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, VMP_DATA_DIR: dataDir, VMP_BIND: '127.0.0.1', VMP_PORT: '0', PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  const ports = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('panel did not start: ' + out)), 25000);
    const iv = setInterval(() => {
      const m = out.match(/VMP_LISTENING port=(\d+) machinePort=(\d+)/);
      if (m) { clearTimeout(t); clearInterval(iv); resolve({ port: +m[1], machinePort: +m[2] }); }
    }, 150);
  });
  const { port, machinePort } = ports;
  rec('panel boots against real docker', true, `api :${port} screens :${machinePort}`);

  // ---- build identity is reported (drift visibility) ----
  const setup = await J(port, 'POST', '/api/setup', null, { username: 'qaadmin', password: 'e2e-real-check-2026' });
  rec('first admin created', setup.status === 201, `status=${setup.status}`);
  const cookie = String(setup.headers['set-cookie'] || '').match(/vmp_session=[^;]+/)?.[0] || null;

  const state = await req(port, { p: '/api/state', headers: { Cookie: cookie, Host: `127.0.0.1:${port}` } });
  let st = null; try { st = JSON.parse(state.body); } catch { /* */ }
  rec('VM reported running via real colima', st?.vm?.running === true, `vm=${JSON.stringify(st?.vm?.status)} cpu=${st?.vm?.cpu} memGiB=${st?.vm?.memoryGiB}`);
  rec('build identity exposed (drift visibility)', !!st?.panel?.build && st.panel.build !== 'unknown', `build=${st?.panel?.build} source=${st?.panel?.buildSource} branch=${st?.panel?.branch}`);

  // ---- readiness endpoint reflects real docker ----
  const ready = await req(port, { p: '/readyz' });
  rec('/readyz reports dependencies', ready.status === 200, `status=${ready.status} body=${ready.body.slice(0, 120)}`);

  // ---- CREATE A REAL DESKTOP ----
  console.log('\n  creating a real XFCE desktop container (this pulls nothing; image is local)…');
  const t0 = Date.now();
  const create = await J(port, 'POST', '/api/machines', cookie, { template: 'linux-desktop' });
  let cj = null; try { cj = JSON.parse(create.body); } catch { /* */ }
  machineName = cj?.name || null;
  rec('machine create accepted', create.status === 202 && !!machineName, `status=${create.status} name=${machineName} in ${Date.now() - t0}ms`);
  if (!machineName) throw new Error('no machine created: ' + create.body.slice(0, 300));

  // ---- hardening flags actually applied to the real container ----
  const insp = JSON.parse(execFileSync(DOCKER, ['inspect', machineName], { encoding: 'utf8' }))[0];
  const hc = insp.HostConfig;
  rec('no-new-privileges applied', (hc.SecurityOpt || []).some((s) => /no-new-privileges/.test(s)), `SecurityOpt=${JSON.stringify(hc.SecurityOpt)}`);
  const dropped = (hc.CapDrop || []).map((c) => c.toUpperCase().replace(/^CAP_/, ''));
  rec('dangerous capabilities dropped', ['NET_RAW', 'MKNOD', 'SYS_CHROOT'].every((c) => dropped.includes(c)), `CapDrop=${JSON.stringify(dropped)}`);
  rec('pids-limit set', (hc.PidsLimit || 0) > 0, `PidsLimit=${hc.PidsLimit}`);
  rec('memory cap applied (no-swap VM)', hc.Memory > 0 && hc.MemorySwap === hc.Memory, `Memory=${(hc.Memory / 1048576).toFixed(0)}MiB MemorySwap=${(hc.MemorySwap / 1048576).toFixed(0)}MiB`);
  rec('restart policy bounded (no OOM storm)', hc.RestartPolicy?.Name === 'on-failure' && hc.RestartPolicy?.MaximumRetryCount === 3, `policy=${JSON.stringify(hc.RestartPolicy)}`);
  rec('ulimit nofile set', (hc.Ulimits || []).some((u) => u.Name === 'nofile'), `Ulimits=${JSON.stringify(hc.Ulimits)}`);

  // per-machine network isolation
  const nets = Object.keys(insp.NetworkSettings.Networks || {});
  rec('on its own per-machine network', nets.length === 1 && nets[0] === `vmp-net-${machineName}`, `networks=${JSON.stringify(nets)}`);

  // UI port must be loopback-only in the VM
  const uiBinds = insp.HostConfig.PortBindings?.['6901/tcp'] || [];
  rec('screen port bound to loopback only', uiBinds.every((b) => b.HostIp === '127.0.0.1'), `6901 -> ${JSON.stringify(uiBinds)}`);

  // per-machine derived credential, and NOT the shared literal
  const env = insp.Config.Env || [];
  const vncPw = (env.find((e) => e.startsWith('VNC_PW=')) || '').slice(7);
  rec('per-machine VNC credential (not the shared "secret")', !!vncPw && vncPw !== 'secret' && vncPw.length >= 16, `len=${vncPw.length} isLiteralSecret=${vncPw === 'secret'}`);
  rec('credential scheme labelled, credential NOT in labels', insp.Config.Labels?.['vmpanel.authv'] === '2' && !JSON.stringify(insp.Config.Labels).includes(vncPw), `authv=${insp.Config.Labels?.['vmpanel.authv']}`);

  // ---- wait for the desktop to become healthy, then PROXY THE REAL SCREEN ----
  console.log('\n  waiting for the desktop to report healthy…');
  let health = 'unknown', waited = 0;
  while (waited < 120000) {
    const h = execFileSync(DOCKER, ['inspect', machineName, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'], { encoding: 'utf8' }).trim();
    health = h;
    if (h === 'healthy') break;
    await sleep(3000); waited += 3000;
  }
  rec('desktop container reports healthy', health === 'healthy', `health=${health} after ${(waited / 1000).toFixed(0)}s`);

  // The real test: does the panel proxy serve the screen over its authenticated proxy?
  const screen = await req(machinePort, { p: `/m/${machineName}/`, headers: { Cookie: cookie, Host: `127.0.0.1:${machinePort}` } });
  rec('authenticated proxy serves the live screen', [200, 302].includes(screen.status), `GET /m/${machineName}/ -> ${screen.status} len=${screen.body.length}`);
  const vnc = await req(machinePort, { p: `/m/${machineName}/vnc.html`, headers: { Cookie: cookie, Host: `127.0.0.1:${machinePort}` } });
  const looksLikeViewer = /vnc|noVNC|kasm/i.test(vnc.body);
  rec('viewer HTML delivered through the proxy', vnc.status === 200 && looksLikeViewer, `vnc.html -> ${vnc.status} len=${vnc.body.length} viewerMarkup=${looksLikeViewer}`);
  rec('proxied response carries no backend Set-Cookie', !('set-cookie' in vnc.headers), `set-cookie=${JSON.stringify(vnc.headers['set-cookie'] || null)}`);

  // unauthenticated must NOT reach the screen
  const noAuth = await req(machinePort, { p: `/m/${machineName}/vnc.html`, headers: { Host: `127.0.0.1:${machinePort}` } });
  rec('unauthenticated screen access refused', noAuth.status !== 200, `status=${noAuth.status}`);

  // ---- machine appears in state with correct ownership ----
  const state2 = await req(port, { p: '/api/state', headers: { Cookie: cookie, Host: `127.0.0.1:${port}` } });
  const s2 = JSON.parse(state2.body);
  const card = (s2.machines || []).find((m) => m.name === machineName);
  rec('machine listed with owner + capped badge', !!card && card.owner === 'qaadmin', `state=${card?.state} owner=${card?.owner} capped=${card?.capped}`);

  // ---- lifecycle: stop then delete ----
  const stop = await J(port, 'POST', `/api/machines/${machineName}/stop`, cookie, {});
  rec('stop succeeds', stop.status < 400, `status=${stop.status}`);

} catch (e) {
  rec('E2E aborted', false, e.message);
  console.log(e.stack?.split('\n').slice(0, 5).join('\n'));
} finally {
  // ---- cleanup: remove the container and its network ----
  if (machineName) {
    try { execFileSync(DOCKER, ['rm', '-f', machineName], { stdio: 'ignore' }); } catch { /* */ }
    try { execFileSync(DOCKER, ['network', 'rm', `vmp-net-${machineName}`], { stdio: 'ignore' }); } catch { /* */ }
    console.log(`\n  cleaned up container + network for ${machineName}`);
  }
  if (proc) { try { proc.kill('SIGKILL'); } catch { /* */ } }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n========== REAL E2E: ${results.length - failed.length}/${results.length} passed ==========`);
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  process.exit(failed.length ? 1 : 0);
}
