// Integration-test harness: spawn a real server.js wired to the fake docker/
// colima shims and a temp data dir, on an ephemeral port. Zero dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const NODE = process.execPath;

// Spawn a panel. opts: { world (initial docker state), colimaStatus, dockerDown, env, config }.
export async function spawnPanel(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmp-it-'));
  const statePath = path.join(dataDir, 'docker-world.json');
  fs.writeFileSync(statePath, JSON.stringify(opts.world || { nextId: 1, containers: {} }));
  if (opts.config) fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(opts.config));

  const env = {
    ...process.env,
    VMP_DOCKER: path.join(ROOT, 'test', 'fixtures', 'fake-docker.js'),
    VMP_COLIMA: path.join(ROOT, 'test', 'fixtures', 'fake-colima.js'),
    VMP_DATA_DIR: dataDir,
    VMP_PORT: '0',
    VMP_BIND: '127.0.0.1',
    FAKE_DOCKER_STATE: statePath,
    FAKE_COLIMA_STATUS: opts.colimaStatus || 'Running',
    ...(opts.dockerDown ? { FAKE_DOCKER_DOWN: '1' } : {}),
    ...(opts.env || {}),
  };

  const proc = spawn(NODE, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const { port, machinePort } = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('panel did not start in time: ' + out)), 8000);
    proc.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/VMP_LISTENING port=(\d+) machinePort=(\d+)/);
      if (m) { clearTimeout(t); resolve({ port: Number(m[1]), machinePort: Number(m[2]) }); }
    });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error('panel exited early code=' + c + ' ' + out)); });
  });

  const base = `http://127.0.0.1:${port}`;
  const machineBase = `http://127.0.0.1:${machinePort}`;
  const panel = {
    base, machineBase, proc, dataDir, statePath, port, machinePort,
    stdout: () => out,
    readWorld: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    writeWorld: (w) => fs.writeFileSync(statePath, JSON.stringify(w, null, 2)),
    kill() { try { proc.kill('SIGKILL'); } catch { /* ignore */ } try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } },
    // fetch wrapper: default JSON mutations get Content-Type + Origin so the
    // guards pass; pass raw:true to omit them (for guard tests).
    async req(method, p, { body, cookie, headers = {}, raw = false, machine = false } = {}) {
      const b = machine ? machineBase : base;
      const h = { ...headers };
      if (cookie) h.Cookie = cookie;
      if (!raw && (method === 'POST' || method === 'DELETE' || method === 'PATCH' || method === 'PUT')) {
        h['Content-Type'] = h['Content-Type'] || 'application/json';
        h.Origin = h.Origin || b;
      }
      const res = await fetch(b + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie');
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* text route */ }
      return { status: res.status, json, text, setCookie, headers: res.headers };
    },
  };
  return panel;
}

// Extract the "vmp_session=<v>" cookie pair from a Set-Cookie header.
export function cookieFrom(setCookie) {
  if (!setCookie) return null;
  const m = setCookie.match(/vmp_session=[^;]+/);
  return m ? m[0] : null;
}

// Create the first admin and return its session cookie.
export async function setupAdmin(panel, username = 'admin', password = 'admin-password-1') {
  const r = await panel.req('POST', '/api/setup', { body: { username, password } });
  if (r.status !== 201) throw new Error('setup failed: ' + r.status + ' ' + r.text);
  return cookieFrom(r.setCookie);
}

// Log in an existing user and return its session cookie.
export async function login(panel, username, password) {
  const r = await panel.req('POST', '/api/login', { body: { username, password } });
  if (r.status !== 200) throw new Error('login failed: ' + r.status + ' ' + r.text);
  return cookieFrom(r.setCookie);
}
