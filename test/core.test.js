import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateName, validateUsername, firstFreePort, nextName, hostPortFor, hostBindingFor,
  publishedPorts, usedHostPorts, mapState, actionsFor, buildUiUrl, mapContainerToCard,
  buildRunArgs, parseColimaList, pickLanAddress, RESERVED_PORTS,
  filterMachinesForUser, canUserActOnMachine, quotaUsage, USER_RUNNING_LIMIT, QUOTA_STATES,
  isPanelMachine, machineAccess, canView, canUse, canDelete, canManageAccess,
  quotaExceeded, TEMPLATES, listTemplates,
} from '../lib/core.js';

test('validateName accepts docker names, rejects flags and junk', () => {
  assert.ok(validateName('chrome-node-1'));
  assert.ok(validateName('desktop_2.a'));
  assert.ok(!validateName('--privileged'));
  assert.ok(!validateName('a;rm -rf'));
  assert.ok(!validateName('has space'));
  assert.ok(!validateName(''));
  assert.ok(!validateName(null));
});

test('validateUsername: lowercase label-safe 3-32', () => {
  assert.ok(validateUsername('alice'));
  assert.ok(validateUsername('bob_2-x'));
  assert.ok(!validateUsername('Al'));           // uppercase
  assert.ok(!validateUsername('ab'));           // too short
  assert.ok(!validateUsername('1abc'));         // starts with digit
  assert.ok(!validateUsername('a'.repeat(33))); // too long
  assert.ok(!validateUsername('has space'));
  assert.ok(!validateUsername(null));
});

test('firstFreePort skips used and reserved ports', () => {
  assert.equal(firstFreePort([7901, 7999], new Set()), 7901);
  assert.equal(firstFreePort([7901, 7999], new Set([7901, 7902])), 7903);
  assert.equal(firstFreePort([9000, 9001], new Set()), 9001); // 9000 reserved
  assert.equal(firstFreePort([9000, 9000], new Set()), null);
});

test('firstFreePort returns null when range exhausted', () => {
  assert.equal(firstFreePort([100, 101], new Set([100, 101])), null);
});

test('nextName increments the highest numeric suffix', () => {
  assert.equal(nextName('desktop', []), 'desktop-1');
  assert.equal(nextName('desktop', ['/desktop-1', '/desktop-3', '/other']), 'desktop-4');
  assert.equal(nextName('chrome-node', ['chrome-node-2']), 'chrome-node-3');
  assert.equal(nextName('desktop', ['portainer', 'linux-desktop']), 'desktop-1');
});

test('hostPortFor and publishedPorts read PortBindings', () => {
  const insp = {
    HostConfig: { PortBindings: { '6080/tcp': [{ HostIp: '127.0.0.1', HostPort: '6081' }] } },
  };
  assert.equal(hostPortFor(insp, 6080), 6081);
  assert.equal(hostPortFor(insp, 4444), null);
  assert.deepEqual(publishedPorts(insp), [{ host: 6081, container: 6080 }]);
});

test('hostBindingFor reports lan flag from HostIp', () => {
  const loopback = { HostConfig: { PortBindings: { '4444/tcp': [{ HostIp: '127.0.0.1', HostPort: '4445' }] } } };
  const lan = { HostConfig: { PortBindings: { '4444/tcp': [{ HostIp: '0.0.0.0', HostPort: '4446' }] } } };
  const empty = { HostConfig: { PortBindings: { '4444/tcp': [{ HostIp: '', HostPort: '4447' }] } } };
  assert.deepEqual(hostBindingFor(loopback, 4444), { port: 4445, lan: false });
  assert.deepEqual(hostBindingFor(lan, 4444), { port: 4446, lan: true });
  assert.deepEqual(hostBindingFor(empty, 4444), { port: 4447, lan: true });
  assert.equal(hostBindingFor(loopback, 9999), null);
});

test('usedHostPorts unions across containers', () => {
  const a = { HostConfig: { PortBindings: { '6080/tcp': [{ HostPort: '6081' }] } } };
  const b = { HostConfig: { PortBindings: { '7900/tcp': [{ HostPort: '7901' }], '4444/tcp': [{ HostPort: '4445' }] } } };
  const used = usedHostPorts([a, b]);
  assert.ok(used.has(6081) && used.has(7901) && used.has(4445));
  assert.ok(!used.has(9999));
});

test('mapState and actionsFor cover the lifecycle', () => {
  assert.equal(mapState('running').state, 'running');
  assert.equal(mapState('exited').state, 'stopped');
  assert.equal(mapState('created').state, 'stopped');
  assert.equal(mapState('paused').state, 'paused');
  assert.deepEqual(actionsFor('running'), ['stop', 'restart', 'logs']);
  assert.deepEqual(actionsFor('stopped'), ['start', 'logs']);
  assert.ok(actionsFor('paused').includes('unpause'));
});

test('buildUiUrl is panel-relative and injects the noVNC ws path', () => {
  assert.equal(
    buildUiUrl('desktop-1', '/vnc.html?autoconnect=true&resize=scale', { mode: 'query', value: 'secret' }),
    '/m/desktop-1/vnc.html?autoconnect=true&resize=scale&path=m%2Fdesktop-1%2Fwebsockify&password=secret',
  );
  assert.equal(
    buildUiUrl('chrome-node-1', '/vnc.html', { mode: 'prompt', hint: 'secret' }),
    '/m/chrome-node-1/vnc.html?path=m%2Fchrome-node-1%2Fwebsockify',
  );
  // legacy label path '/'
  assert.equal(
    buildUiUrl('chrome-node-9', '/', { mode: 'prompt', hint: 'secret' }),
    '/m/chrome-node-9/?path=m%2Fchrome-node-9%2Fwebsockify',
  );
});

test('mapContainerToCard: managed linux-desktop with owner (KasmVNC media, no URL password)', () => {
  const insp = {
    Name: '/desktop-2',
    Config: {
      Image: 'minimal-linux-desktop:xfce',
      Labels: {
        'vmpanel.managed': '1', 'vmpanel.template': 'linux-desktop', 'vmpanel.owner': 'alice',
        'vmpanel.ui.port': '6201', 'vmpanel.webcam': '1',
      },
    },
    State: { Status: 'running', StartedAt: '2026-07-09T00:00:00Z' },
    HostConfig: { PortBindings: { '6901/tcp': [{ HostIp: '127.0.0.1', HostPort: '6201' }] } },
  };
  const c = mapContainerToCard(insp);
  assert.equal(c.name, 'desktop-2');
  assert.equal(c.owner, 'alice');
  assert.equal(c.managed, true);
  assert.equal(c.embeddable, true);
  assert.equal(c.localOnly, false);
  assert.equal(c.uiPort, 6201);
  assert.equal(c.media, true);
  assert.equal(c.camera, true, 'webcam label → camera available');
  assert.ok(c.uiUrl.startsWith('/m/desktop-2/vnc.html?'));
  assert.ok(!c.uiUrl.includes('password='), 'KasmVNC uses injected Basic auth — no VNC password in URL');
  assert.ok(c.uiUrl.includes('path=m%2Fdesktop-2%2Fwebsockify'));
});

test('mapContainerToCard: managed chrome-node — template ui beats stale label, autoconnect + query password', () => {
  const insp = {
    Name: '/chrome-node-1',
    Config: {
      Image: 'local-seleniarm/standalone-chromium:4.5.0-20260701',
      Labels: {
        'vmpanel.managed': '1', 'vmpanel.template': 'chrome-node', 'vmpanel.owner': 'bob',
        // Old-style label from a container created before the autoconnect change —
        // the CURRENT template definition must win so existing nodes are repaired.
        'vmpanel.ui.port': '7901', 'vmpanel.ui.path': '/vnc.html', 'vmpanel.webdriver.port': '4445',
      },
    },
    State: { Status: 'running' },
    HostConfig: { PortBindings: { '7900/tcp': [{ HostIp: '127.0.0.1', HostPort: '7901' }], '4444/tcp': [{ HostIp: '127.0.0.1', HostPort: '4445' }] } },
  };
  const c = mapContainerToCard(insp);
  assert.equal(c.template, 'chrome-node');
  assert.equal(c.owner, 'bob');
  assert.equal(c.passwordHint, null, 'query-mode password → no manual hint needed');
  assert.deepEqual(c.webdriver, { port: 4445, lan: false });
  assert.equal(c.uiUrl, '/m/chrome-node-1/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=2000&path=m%2Fchrome-node-1%2Fwebsockify&password=secret');
});

test('mapContainerToCard: unknown managed template falls back to the ui.path label', () => {
  const insp = {
    Name: '/old-tool-1',
    Config: {
      Image: 'some/old:1',
      Labels: {
        'vmpanel.managed': '1', 'vmpanel.template': 'retired-template', 'vmpanel.owner': 'bob',
        'vmpanel.ui.port': '7905', 'vmpanel.ui.path': '/custom.html',
      },
    },
    State: { Status: 'running' },
    HostConfig: { PortBindings: { '7900/tcp': [{ HostIp: '127.0.0.1', HostPort: '7905' }] } },
  };
  const c = mapContainerToCard(insp);
  assert.equal(c.uiUrl, '/m/old-tool-1/custom.html?path=m%2Fold-tool-1%2Fwebsockify', 'label path used when the template is gone');
});

test('templates: selenium nodes declare wdBrowserName for live sessions', () => {
  assert.equal(TEMPLATES['chrome-node'].wdBrowserName, 'chrome');
  assert.equal(TEMPLATES['firefox-node'].wdBrowserName, 'firefox');
  assert.equal(TEMPLATES['linux-desktop'].wdBrowserName, undefined, 'desktops have no webdriver');
});

test('mapContainerToCard: adopted xfce desktop → linux-desktop, media, proxied url', () => {
  const insp = {
    Name: '/linux-desktop',
    Config: { Image: 'minimal-linux-desktop:xfce', Labels: {} },
    State: { Status: 'running' },
    HostConfig: { PortBindings: { '6901/tcp': [{ HostIp: '127.0.0.1', HostPort: '6201' }] } },
  };
  const c = mapContainerToCard(insp);
  assert.equal(c.adopted, true);
  assert.equal(c.template, 'linux-desktop');
  assert.equal(c.owner, null);
  assert.equal(c.embeddable, true);
  assert.equal(c.media, true);
  assert.ok(c.uiUrl.startsWith('/m/linux-desktop/'));
});

test('mapContainerToCard: managed icewm-desktop is media, camera from webcam label, no URL password', () => {
  const mk = (webcam) => mapContainerToCard({
    Name: '/desktop-1',
    Config: { Image: 'minimal-linux-desktop:icewm', Labels: {
      'vmpanel.managed': '1', 'vmpanel.template': 'icewm-desktop', 'vmpanel.owner': 'alice',
      'vmpanel.ui.port': '6202', 'vmpanel.webcam': webcam,
    } },
    State: { Status: 'running' },
    HostConfig: { PortBindings: { '6901/tcp': [{ HostIp: '127.0.0.1', HostPort: '6202' }] } },
  });
  const cam = mk('1');
  assert.equal(cam.template, 'icewm-desktop');
  assert.equal(cam.media, true);
  assert.equal(cam.camera, true);
  assert.equal(cam.embeddable, true);
  assert.ok(cam.uiUrl.startsWith('/m/desktop-1/vnc.html'));
  assert.ok(cam.uiUrl.includes('path=m%2Fdesktop-1%2Fwebsockify'));
  assert.ok(!cam.uiUrl.includes('password='), 'media auth is Basic (no VNC password in URL)');
  assert.equal(mk('0').camera, false, 'webcam=0 → camera unavailable');
});

test('mapContainerToCard: adopted :icewm image → icewm-desktop, media', () => {
  const c = mapContainerToCard({
    Name: '/icewm-adopted',
    Config: { Image: 'minimal-linux-desktop:icewm', Labels: {} },
    State: { Status: 'running' },
    HostConfig: { PortBindings: { '6901/tcp': [{ HostIp: '127.0.0.1', HostPort: '6250' }] } },
  });
  assert.equal(c.adopted, true);
  assert.equal(c.template, 'icewm-desktop');
  assert.equal(c.media, true);
  assert.equal(c.camera, null, 'no webcam label on an adopted container → unknown');
  assert.ok(c.uiUrl.startsWith('/m/icewm-adopted/'));
});

test('mapContainerToCard: portainer is protected, local-only, not embeddable', () => {
  const insp = {
    Name: '/portainer',
    Config: { Image: 'portainer/portainer-ce:latest', Labels: {} },
    State: { Status: 'running' },
    HostConfig: { PortBindings: { '9000/tcp': [{ HostIp: '127.0.0.1', HostPort: '9000' }] } },
  };
  const c = mapContainerToCard(insp);
  assert.equal(c.protected, true);
  assert.equal(c.embeddable, false);
  assert.equal(c.localOnly, true);
  assert.equal(c.uiUrl, 'http://127.0.0.1:9000');
});

test('buildRunArgs writes owner label, loopback ui, configurable webdriver bind', () => {
  const args = buildRunArgs({
    template: 'chrome-node', name: 'chrome-node-1', owner: 'alice',
    ports: { ui: 7901, webdriver: 4445 }, createdAt: '2026-07-09T00:00:00Z',
    webdriverBind: '0.0.0.0',
  });
  assert.ok(args.includes('vmpanel.owner=alice'));
  assert.ok(args.includes('127.0.0.1:7901:7900'));
  assert.ok(args.includes('0.0.0.0:4445:4444'));
  assert.equal(args[args.length - 1], 'local-seleniarm/standalone-chromium:4.5.0-20260701');
});

test('buildRunArgs defaults webdriver to loopback and requires owner', () => {
  const args = buildRunArgs({
    template: 'chrome-node', name: 'c1', owner: 'bob',
    ports: { ui: 7901, webdriver: 4445 }, createdAt: 'x',
  });
  assert.ok(args.includes('127.0.0.1:4445:4444'));
  assert.throws(() => buildRunArgs({ template: 'linux-desktop', name: 'd1', ports: { ui: 6081 }, createdAt: 'x' }), /owner/);
  assert.throws(() => buildRunArgs({ template: 'linux-desktop', name: 'd1', ports: { ui: 6081 }, createdAt: 'x', owner: 'BadUser' }), /owner/);
});

test('buildRunArgs omits webdriver for linux-desktop', () => {
  const args = buildRunArgs({
    template: 'linux-desktop', name: 'desktop-1', owner: 'alice', ports: { ui: 6081 }, createdAt: 'x',
  });
  assert.ok(!args.some((a) => a.includes('webdriver')));
  assert.ok(args.includes('127.0.0.1:6081:6901'), 'KasmVNC desktops publish container port 6901');
});

test('isPanelMachine: only managed panel-template machines count (incl. icewm)', () => {
  assert.equal(isPanelMachine({ managed: true, template: 'linux-desktop' }), true);
  assert.equal(isPanelMachine({ managed: true, template: 'icewm-desktop' }), true);
  assert.equal(isPanelMachine({ managed: true, template: 'chrome-node' }), true);
  assert.equal(isPanelMachine({ managed: true, template: 'firefox-node' }), true);
  assert.equal(isPanelMachine({ managed: false, template: 'linux-desktop' }), false); // adopted
  assert.equal(isPanelMachine({ managed: true, template: 'unknown' }), false);
  assert.equal(isPanelMachine({ managed: false, template: 'portainer' }), false);
  assert.equal(isPanelMachine(null), false);
});

test('machineAccess truth table + capability derivations', () => {
  const admin = { username: 'root', role: 'admin' };
  const alice = { username: 'alice', role: 'user' };
  const own = { name: 'd1', owner: 'alice' };
  const other = { name: 'd2', owner: 'bob' };
  const shared = new Set(['d2']);
  assert.equal(machineAccess(admin, other), 'admin');
  assert.equal(machineAccess(alice, own), 'owner');
  assert.equal(machineAccess(alice, other, shared), 'shared');
  assert.equal(machineAccess(alice, other, null), null);
  assert.equal(machineAccess(null, own), null);
  assert.equal(machineAccess(alice, null), null);
  // derivations
  assert.equal(canView('shared'), true);
  assert.equal(canUse('shared'), true);
  assert.equal(canDelete('shared'), false);   // shared users cannot delete
  assert.equal(canDelete('owner'), true);
  assert.equal(canDelete('admin'), true);
  assert.equal(canDelete(null), false);
  assert.equal(canManageAccess('admin'), true);
  assert.equal(canManageAccess('owner'), false);
});

test('filterMachinesForUser includes shared machines', () => {
  const cards = [{ name: 'a', owner: 'alice' }, { name: 'b', owner: 'bob' }, { name: 'c', owner: 'carol' }];
  const alice = { username: 'alice', role: 'user' };
  assert.deepEqual(filterMachinesForUser(cards, alice, new Set(['b'])).map((c) => c.name), ['a', 'b']);
  assert.equal(filterMachinesForUser(cards, { username: 'x', role: 'admin' }, null).length, 3);
});

test('quotaExceeded counts running + pending against the limit', () => {
  const cards = [{ owner: 'alice', state: 'running' }];
  assert.equal(quotaExceeded(cards, 'alice', 0), false); // 1 < 2
  assert.equal(quotaExceeded(cards, 'alice', 1), true);  // 1 + 1 pending = 2
  assert.equal(quotaExceeded([{ owner: 'alice', state: 'running' }, { owner: 'alice', state: 'paused' }], 'alice', 0), true);
  assert.equal(quotaExceeded([{ owner: 'alice', state: 'exited' }], 'alice', 0), false);
});

test('template registry: 4 templates, correct images/prefixes/memory', () => {
  const ids = Object.keys(TEMPLATES).sort();
  assert.deepEqual(ids, ['chrome-node', 'firefox-node', 'icewm-desktop', 'linux-desktop']);
  assert.equal(TEMPLATES['linux-desktop'].image, 'minimal-linux-desktop:xfce');
  assert.equal(TEMPLATES['icewm-desktop'].image, 'minimal-linux-desktop:icewm');
  assert.equal(TEMPLATES['linux-desktop'].namePrefix, 'desktop');
  assert.equal(TEMPLATES['icewm-desktop'].namePrefix, 'desktop'); // shared prefix
  assert.equal(TEMPLATES['linux-desktop'].memory, '2048m');
  assert.equal(TEMPLATES['icewm-desktop'].memory, '1536m');
  assert.equal(TEMPLATES['chrome-node'].memory, '2048m');
  const lt = listTemplates();
  assert.equal(lt.length, 4);
  assert.ok(lt.find((t) => t.id === 'linux-desktop').hint.includes('Recommended'));
  assert.equal(lt.find((t) => t.id === 'linux-desktop').media, true, 'listTemplates surfaces the media flag');
});

test('desktop templates: BOTH are KasmVNC media (TLS + Basic-auth, VNC_PW, camera OFF, no URL password)', () => {
  for (const id of ['linux-desktop', 'icewm-desktop']) {
    const m = TEMPLATES[id];
    assert.equal(m.media, true, `${id} is media (mic + speaker)`);
    assert.equal(m.needsWebcam, false, `${id} has camera OFF by default (webcam service is a CPU hog)`);
    assert.equal(m.backendTls, true, `${id} speaks HTTPS to the backend`);
    assert.deepEqual(m.backendAuth, { user: 'kasm_user', pass: 'secret' });
    assert.deepEqual(m.env, [{ name: 'VNC_PW', value: 'secret' }, { name: 'KASM_SVC_WEBCAM', value: '0' }], `${id}: audio env + webcam service disabled`);
    assert.equal(m.ui.password.mode, 'none', `${id}: Basic auth, no VNC password in URL`);
    assert.equal(m.ports.find((p) => p.role === 'ui').containerPort, 6901);
    assert.equal(m.ports.find((p) => p.role === 'audio')?.containerPort, 4901, `${id} publishes the audio-out port for speaker`);
  }
  assert.equal(TEMPLATES['linux-desktop'].image, 'minimal-linux-desktop:xfce');
  assert.equal(TEMPLATES['icewm-desktop'].image, 'minimal-linux-desktop:icewm');
});

test('buildRunArgs desktop: emits VNC_PW + KASM_SVC_WEBCAM=0; never maps a camera device (webcam off by default)', () => {
  // Camera is OFF by default: Kasm's webcam service busy-loops against an idle
  // v4l2loopback device (~1-1.5 vCPU/desktop), so both templates set
  // needsWebcam:false and pass KASM_SVC_WEBCAM=0. Mic + speaker are unaffected.
  const base = { template: 'linux-desktop', name: 'desktop-1', owner: 'alice', ports: { ui: 6201, audio: 4911 }, createdAt: 'x' };
  const envOf = (args) => args.reduce((acc, a, i) => (args[i - 1] === '-e' ? [...acc, a] : acc), []);
  const noCam = buildRunArgs(base);
  assert.ok(envOf(noCam).includes('VNC_PW=secret'), 'VNC_PW env present (audio auth)');
  assert.ok(envOf(noCam).includes('KASM_SVC_WEBCAM=0'), 'webcam service disabled — the idle-CPU-hog fix');
  assert.ok(!noCam.includes('--device'), 'no camera device mapped');
  assert.ok(!noCam.some((a) => String(a).startsWith('vmpanel.webcam=')), 'no webcam label (camera off, not host-conditional)');
  assert.ok(noCam.includes('127.0.0.1:6201:6901'), 'loopback-bound KasmVNC port');
  // Audio-out port published (loopback) + labelled, so the panel can proxy speaker audio.
  assert.ok(noCam.includes('127.0.0.1:4911:4901'), 'audio-out websocket port published to loopback');
  assert.ok(noCam.includes('vmpanel.audio.port=4911'), 'audio-out host port recorded on a label');
  assert.equal(noCam[noCam.length - 1], 'minimal-linux-desktop:xfce');
  // Even when the host HAS a camera device, desktops no longer map it by default.
  const withHostCam = buildRunArgs({ ...base, hostWebcam: true });
  assert.ok(!withHostCam.includes('--device'), 'camera stays off even when the host has a device (needsWebcam:false)');
  assert.ok(!withHostCam.includes('--memory'), 'shared by default (no caps)');
});

test('buildRunArgs: Selenium nodes (non-media) emit no VNC_PW env or webcam label', () => {
  const d = buildRunArgs({ template: 'chrome-node', name: 'c1', owner: 'alice', ports: { ui: 7901, webdriver: 4445 }, createdAt: 'x' });
  assert.ok(!d.some((a) => String(a).startsWith('VNC_PW=')), 'no VNC_PW for Selenium nodes');
  assert.ok(!d.some((a) => String(a).startsWith('vmpanel.webcam=')), 'no webcam label for non-media');
  assert.ok(!d.some((a) => String(a).startsWith('vmpanel.audio.port=')), 'no audio-out port for non-media nodes');
});

test('buildRunArgs: resources shared by default (no caps), capped label 0', () => {
  const desk = buildRunArgs({ template: 'linux-desktop', name: 'desktop-1', owner: 'alice', ports: { ui: 6081 }, createdAt: 'x' });
  assert.ok(!desk.includes('--memory'), 'no memory cap by default (shared)');
  assert.ok(!desk.includes('--cpus'), 'no cpu cap by default (shared)');
  assert.ok(desk.includes('vmpanel.capped=0'), 'labelled uncapped');
});

test('buildRunArgs: cap=true applies per-template memory + cpu caps, capped label 1', () => {
  const desk = buildRunArgs({ template: 'linux-desktop', name: 'desktop-1', owner: 'alice', ports: { ui: 6081 }, createdAt: 'x', cap: true });
  assert.equal(desk[desk.indexOf('--memory') + 1], '2048m');
  assert.equal(desk[desk.indexOf('--memory-swap') + 1], '2048m');
  assert.equal(desk[desk.indexOf('--cpus') + 1], '2');
  assert.ok(desk.includes('vmpanel.capped=1'), 'labelled capped');
  const ice = buildRunArgs({ template: 'icewm-desktop', name: 'desktop-2', owner: 'alice', ports: { ui: 6082 }, createdAt: 'x', cap: true });
  assert.equal(ice[ice.indexOf('--memory') + 1], '1536m');
  const chr = buildRunArgs({ template: 'chrome-node', name: 'chrome-node-1', owner: 'alice', ports: { ui: 7901, webdriver: 4445 }, createdAt: 'x', cap: true });
  assert.equal(chr[chr.indexOf('--memory') + 1], '2048m');
});

test('nextName shares the desktop prefix across xfce + icewm variants', () => {
  assert.equal(nextName('desktop', ['desktop-1', 'desktop-2']), 'desktop-3');
});

test('parseColimaList exposes raw memory/disk bytes', () => {
  const vm = parseColimaList('{"name":"default","status":"Running","cpus":4,"memory":6442450944,"disk":64424509440}');
  assert.equal(vm.memoryBytes, 6442450944);
  assert.equal(vm.diskBytes, 64424509440);
});

test('mapContainerToCard exposes exitCode', () => {
  const c = mapContainerToCard({ Name: '/desktop-2', Config: { Image: 'minimal-linux-desktop:icewm', Labels: { 'vmpanel.managed': '1', 'vmpanel.template': 'icewm-desktop', 'vmpanel.owner': 'alice' } }, State: { Status: 'exited', ExitCode: 137 }, HostConfig: { PortBindings: {} } });
  assert.equal(c.exitCode, 137);
  assert.equal(c.template, 'icewm-desktop');
});

test('filterMachinesForUser and canUserActOnMachine', () => {
  const cards = [
    { name: 'a', owner: 'alice', state: 'running' },
    { name: 'b', owner: 'bob', state: 'running' },
    { name: 'legacy', owner: null, state: 'running' },
  ];
  const alice = { username: 'alice', role: 'user' };
  const admin = { username: 'root', role: 'admin' };
  assert.deepEqual(filterMachinesForUser(cards, alice).map((c) => c.name), ['a']);
  assert.equal(filterMachinesForUser(cards, admin).length, 3);
  assert.deepEqual(filterMachinesForUser(cards, null), []);
  assert.equal(canUserActOnMachine(alice, cards[0]), true);
  assert.equal(canUserActOnMachine(alice, cards[1]), false);
  assert.equal(canUserActOnMachine(alice, cards[2]), false);
  assert.equal(canUserActOnMachine(admin, cards[2]), true);
});

test('quotaUsage counts running/restarting/paused only', () => {
  const cards = [
    { owner: 'alice', state: 'running' },
    { owner: 'alice', state: 'paused' },
    { owner: 'alice', state: 'stopped' },
    { owner: 'bob', state: 'running' },
  ];
  assert.deepEqual(quotaUsage(cards, 'alice'), { used: 2, limit: USER_RUNNING_LIMIT });
  assert.deepEqual(quotaUsage(cards, 'bob'), { used: 1, limit: USER_RUNNING_LIMIT });
  assert.ok(QUOTA_STATES.has('restarting'));
  assert.ok(!QUOTA_STATES.has('stopped'));
});

test('pickLanAddress prefers en0, then low en*, skips virtual ifaces', () => {
  const base = { family: 'IPv4', internal: false };
  assert.equal(pickLanAddress({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    utun3: [{ ...base, address: '100.64.0.5' }],
    en0: [{ ...base, address: '192.168.1.20' }],
    en5: [{ ...base, address: '192.168.1.99' }],
  }), '192.168.1.20');
  assert.equal(pickLanAddress({
    en12: [{ ...base, address: '10.0.0.7' }],
    en5: [{ ...base, address: '10.0.0.5' }],
  }), '10.0.0.5');
  assert.equal(pickLanAddress({ awdl0: [{ ...base, address: '169.254.1.1' }] }), null);
  assert.equal(pickLanAddress({}), null);
});

test('parseColimaList reads running default profile', () => {
  const out = '{"name":"default","status":"Running","arch":"aarch64","cpus":4,"memory":6442450944,"disk":64424509440,"runtime":"docker"}';
  const vm = parseColimaList(out);
  assert.equal(vm.running, true);
  assert.equal(vm.cpu, 4);
  assert.equal(vm.memoryGiB, 6);
  assert.equal(vm.diskGiB, 60);
  assert.equal(vm.arch, 'aarch64');
});

test('parseColimaList handles stopped and empty', () => {
  assert.equal(parseColimaList('{"name":"default","status":"Stopped"}').running, false);
  assert.equal(parseColimaList('').running, false);
});

test('RESERVED_PORTS protects the panel and infra ports', () => {
  for (const p of [5050, 6080, 7900, 4444, 9000, 9443]) assert.ok(RESERVED_PORTS.has(p));
});
