#!/usr/bin/env node
// Fake `docker` CLI for integration tests. Models a container "world" in the
// JSON file at $FAKE_DOCKER_STATE. Implements only the subcommands server.js
// uses. If $FAKE_DOCKER_DOWN is set, every command fails like a dead daemon.
import fs from 'node:fs';

const STATE = process.env.FAKE_DOCKER_STATE;
const argv = process.argv.slice(2);

function down() {
  process.stderr.write('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
  process.exit(1);
}
if (process.env.FAKE_DOCKER_DOWN) down();

function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { nextId: 1, containers: {} }; }
}
function save(w) { fs.writeFileSync(STATE, JSON.stringify(w, null, 2)); }
function fail(msg) { process.stderr.write(msg + '\n'); process.exit(1); }
// "2048m" / "2g" / plain bytes -> bytes (docker --memory syntax).
function memBytes(v) { const m = String(v).match(/^(\d+(?:\.\d+)?)([kmg])?$/i); if (!m) return 0; const n = Number(m[1]); const u = (m[2] || '').toLowerCase(); return Math.round(n * (u === 'g' ? 1073741824 : u === 'm' ? 1048576 : u === 'k' ? 1024 : 1)); }

const w = load();
const byId = (id) => Object.entries(w.containers).find(([, c]) => c.id === id);
const cmd = argv[0];

// Optional per-subcommand invocation counter (proves the /api/state cache: a
// burst of polls must trigger at most one `ps` pass within the TTL window).
if (process.env.FAKE_DOCKER_COUNT && (cmd === 'ps' || cmd === 'inspect')) {
  try {
    const f = process.env.FAKE_DOCKER_COUNT;
    let counts = {}; try { counts = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* first write */ }
    counts[cmd] = (counts[cmd] || 0) + 1;
    fs.writeFileSync(f, JSON.stringify(counts));
  } catch { /* counting is best-effort */ }
}

function inspectObj(name, c) {
  const pb = {};
  for (const [cont, host] of Object.entries(c.ports || {})) {
    pb[`${cont}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: String(host) }];
  }
  return {
    Name: '/' + name,
    Config: { Image: c.image, Labels: c.labels || {} },
    State: { Status: c.state, StartedAt: c.startedAt || '2026-07-10T00:00:00Z', ExitCode: c.exitCode ?? 0, OOMKilled: !!c.oomKilled },
    Image: `sha256:${c.imageId || `fake${String(c.image || '').replace(/[^a-z0-9]/gi, '')}`}`,
    HostConfig: { PortBindings: pb, Memory: c.memoryBytes || 0, NanoCpus: c.nanoCpus || 0, RestartPolicy: { Name: c.restart || 'on-failure', MaximumRetryCount: c.restart ? 0 : 3 } },
    NetworkSettings: { Ports: pb },
  };
}

if (cmd === 'ps') {
  if (argv.includes('-aq')) {
    process.stdout.write(Object.values(w.containers).map((c) => c.id).join('\n') + (Object.keys(w.containers).length ? '\n' : ''));
  } else if (argv.includes('--size')) {
    // ps -a --size --format '{{json .}}'
    for (const [name, c] of Object.entries(w.containers)) {
      process.stdout.write(JSON.stringify({ Names: name, Size: `${c.rwMB ?? 10}MB (virtual 1.7GB)` }) + '\n');
    }
  } else {
    // ps -a --format '{{.Names}}'
    process.stdout.write(Object.keys(w.containers).join('\n') + (Object.keys(w.containers).length ? '\n' : ''));
  }
  process.exit(0);
}

if (cmd === 'inspect' && argv[1] === '-f' && argv[2] === '{{.Image}}') {
  const c = w.containers[argv[3]];
  if (!c) fail(`Error: No such object: ${argv[3]}`);
  process.stdout.write(`sha256:fake-${c.image}\n`);
  process.exit(0);
}

if (cmd === 'inspect') {
  const ids = argv.slice(1).filter((a) => !a.startsWith('-') && !a.includes('{{'));
  const out = [];
  for (const id of ids) { const e = byId(id); if (e) out.push(inspectObj(e[0], e[1])); }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

if (cmd === 'run') {
  let name = null, image = null, memory = 0, nanoCpus = 0, device = null; const labels = {}; const ports = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') name = argv[++i];
    else if (a === '-l') { const [k, ...v] = argv[++i].split('='); labels[k] = v.join('='); }
    else if (a === '-p') { const m = argv[++i].match(/^[^:]+:(\d+):(\d+)$/); if (m) ports[m[2]] = m[1]; }
    else if (a === '--device') device = argv[++i];
    else if (a === '-e') i++;
    else if (a === '--memory') memory = memBytes(argv[++i]);
    else if (a === '--cpus') nanoCpus = Math.round(Number(argv[++i]) * 1e9);
    else if (a === '--memory-swap' || a === '--shm-size') i++;
    else if (a === '-d' || a === '--restart') { if (a === '--restart') i++; }
    else if (!a.startsWith('-')) image = a;
  }
  if (!name || !image) fail('docker run: missing --name or image');
  // Simulate a host that lacks the mapped camera device (e.g. stale hostWebcam
  // after a VM rebuild). The panel must degrade to audio-only, not 500.
  if (device && process.env.FAKE_DOCKER_NO_VIDEO) {
    fail(`docker: Error response from daemon: error gathering device information while adding custom device "${device.split(':')[0]}": no such file or directory.`);
  }
  // General failure hook: stderr carries a host path so tests can assert it is
  // redacted from non-admins but shown to admins.
  if (process.env.FAKE_DOCKER_FAIL) {
    fail('docker: Error response from daemon: OCI runtime create failed: /opt/host/private/secret-path: permission denied.');
  }
  if (w.containers[name]) fail(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`);
  const id = 'fake' + String(w.nextId++).padStart(9, '0');
  w.containers[name] = { id, image, labels, ports, state: 'running', exitCode: 0, startedAt: new Date(0).toISOString(), memoryBytes: memory, nanoCpus };
  save(w);
  process.stdout.write(id + '\n');
  process.exit(0);
}

if (['start', 'stop', 'restart', 'unpause', 'rm'].includes(cmd)) {
  const name = argv.filter((a) => !a.startsWith('-') && a !== String(parseInt(a, 10)))[argv.filter((a) => !a.startsWith('-') && a !== String(parseInt(a, 10))).length - 1];
  const c = w.containers[name];
  if (!c) fail(`Error: No such container: ${name}`);
  if (cmd === 'restart' && process.env.FAKE_DOCKER_RESTART_FAIL) fail(`Error response from daemon: Cannot restart container ${name}: fake failure`);
  if (cmd === 'start' || cmd === 'restart' || cmd === 'unpause') {
    c.state = 'running'; c.exitCode = 0;
    // A (re)started session picks up the ~/.bashrc time zone hook, like vnc_startup.sh.
    if (cmd !== 'unpause') c.activeTz = c.tzHook && c.tz ? c.tz : 'Etc/UTC';
  }
  else if (cmd === 'stop') { c.state = 'exited'; c.exitCode = 0; }
  else if (cmd === 'rm') {
    if (c.state === 'running' && !argv.includes('-f')) fail(`Error response from daemon: You cannot remove a running container ${name}. Stop the container before attempting removal or force remove`);
    delete w.containers[name];
  }
  save(w);
  process.stdout.write(name + '\n');
  process.exit(0);
}

// update --restart=<policy> <name>: record the restart policy inspect reports.
if (cmd === 'update') {
  const name = argv[argv.length - 1];
  const c = w.containers[name];
  if (!c) fail(`Error response from daemon: No such container: ${name}`);
  const pol = (argv.find((a) => a.startsWith('--restart=')) || '').slice('--restart='.length);
  if (pol) { c.restart = pol.split(':')[0]; c.updates = [...(c.updates || []), pol]; }
  const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  if (process.env.FAKE_DOCKER_UPDATE_FAIL && val('--memory')) fail('Error response from daemon: fake update failure');
  if (val('--cpus')) c.nanoCpus = Math.round(Number(val('--cpus')) * 1e9);
  if (val('--memory')) c.memoryBytes = memBytes(val('--memory'));
  save(w);
  process.stdout.write(name + '\n');
  process.exit(0);
}

if (cmd === 'logs') {
  process.stdout.write('2026-07-10T00:00:00Z fake log line 1\n2026-07-10T00:00:01Z fake log line 2\n');
  process.exit(0);
}

if (cmd === 'stats') {
  for (const [name, c] of Object.entries(w.containers)) {
    if (c.state !== 'running') continue;
    const limit = c.memoryBytes ? (c.memoryBytes / 1048576).toFixed(0) + 'MiB' : '5.773GiB';
    const usedMiB = c.memUsedMiB ?? 100;
    process.stdout.write(JSON.stringify({
      Name: name, CPUPerc: (c.cpuPerc ?? 1.0).toFixed(2) + '%',
      MemUsage: `${usedMiB}MiB / ${limit}`, MemPerc: '10.0%', PIDs: '120',
    }) + '\n');
  }
  process.exit(0);
}

if (cmd === 'system' && argv[1] === 'df') {
  for (const row of [
    { Type: 'Images', Size: '29.12GB' }, { Type: 'Containers', Size: '1.244GB' },
    { Type: 'Local Volumes', Size: '950.1MB' }, { Type: 'Build Cache', Size: '10.71GB' },
  ]) process.stdout.write(JSON.stringify(row) + '\n');
  process.exit(0);
}

// Minimal stubs for the file-transfer paths (exec: no output; cp: success).
// Enough to exercise routing/authz/validation; real byte movement is covered
// by the browser E2E, not the fake shim.
// exec: the desktop time zone scripts are acted out against the container
// record (tz saved, tzHook installed, activeTz of the running session);
// everything else keeps the old no-output stub.
if (cmd === 'exec') {
  const env = {}; let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-e') { const [k, ...v] = argv[++i].split('='); env[k] = v.join('='); }
    else if (a === '-u' || a === '-w') i++;
    else if (!a.startsWith('-')) break;
  }
  const name = argv[i]; const rest = argv.slice(i + 1);
  const c = w.containers[name];
  if (!c) fail(`Error response from daemon: No such container: ${name}`);
  if (c.state !== 'running') fail(`Error response from daemon: container ${name} is not running`);
  const script = rest[0] === 'sh' && rest[1] === '-c' ? rest[2] || '' : '';
  if (rest[0] === 'cat' && rest[1] === '/usr/share/zoneinfo/zone.tab') {
    process.stdout.write('# tzdata zone.tab\nPH\t+1435+12100\tAsia/Manila\nIN\t+2232+08822\tAsia/Kolkata\nAU\t-3352+15113\tAustralia/Sydney\tNew South Wales\n');
    process.exit(0);
  }
  if (script.includes('PRISM_TZ_MARK')) {
    const known = new Set(['UTC', 'Asia/Manila', 'Asia/Kolkata', 'Australia/Sydney']);
    if (!known.has(env.PRISM_TZ)) process.exit(3);
    c.tz = env.PRISM_TZ;
    if (!c.tzHook) c.tzHook = env.PRISM_TZ_HOOK || true;
    save(w);
    process.exit(0);
  }
  if (script.includes('saved=')) {
    process.stdout.write(`saved=${c.tz || ''}\nactive=${c.activeTz || 'Etc/UTC'}\n`);
    process.exit(0);
  }
  process.exit(0);
}
// Archive streams (archived delete / restore):
//   cp <name>:<dir> -      writes a fake tar of <dir> to stdout
//   cp -a - <name>:<dest>  reads a tar from stdin and records it on the container
// FAKE_DOCKER_CP_FAIL makes the stdout direction fail like an unreadable path.
if (cmd === 'cp') {
  const args = argv.slice(1).filter((a) => a !== '-a' && a !== '-L' && a !== '-q');
  if (args[1] === '-') {
    const [name, dir] = args[0].split(':');
    if (!w.containers[name]) fail(`Error response from daemon: No such container: ${name}`);
    if (process.env.FAKE_DOCKER_CP_FAIL) fail(`Error response from daemon: Could not find the file ${dir} in container ${name}`);
    process.stdout.write(`FAKE-TAR ${name}:${dir}\n${w.containers[name].homeContent || ''}`);
    process.exit(0);
  }
  if (args[0] === '-') {
    const [name, dest] = args[1].split(':');
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const cur = load();
      if (!cur.containers[name]) fail(`Error response from daemon: No such container: ${name}`);
      cur.containers[name].restored = { dest, payload: Buffer.concat(chunks).toString('utf8') };
      save(cur);
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

// `cp -` from stdin finishes asynchronously in its 'end' handler above.
if (cmd !== 'cp') fail(`fake-docker: unsupported command: ${argv.join(' ')}`);
