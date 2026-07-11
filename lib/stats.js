// Pure parsers + payload shaping for the stats / Resources features.
// No I/O — the server runs the docker CLI and feeds stdout here.

import { filterMachinesForUser, isPanelMachine } from './core.js';

const UNITS = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, PiB: 1024 ** 5 };

// "919.3MiB" | "104kB" | "29.12GB" | "0B" -> bytes | null.
export function parseSizeToBytes(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d+(?:\.\d+)?)\s*([kKMGTP]?i?B)$/);
  if (!m) return null;
  const mult = UNITS[m[2]];
  if (mult === undefined) return null;
  return Math.round(parseFloat(m[1]) * mult);
}

function pctToNum(str) {
  const n = parseFloat(String(str).replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

// stdout of `docker stats --no-stream --format '{{json .}}'`.
// -> { byName: Map<name,{cpuPerc,memUsedBytes,memLimitBytes,memPerc,pids}>, memLimitBytes }
// memLimitBytes is the MAX limit seen across lines: with per-container --memory
// caps, each capped container reports its own cap; the uncapped ones report the
// VM cgroup limit, which is the true VM capacity.
export function parseDockerStats(stdout) {
  const byName = new Map();
  let memLimitBytes = null;
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (!o.Name || !o.MemUsage) continue;
    const [usedStr, limitStr] = String(o.MemUsage).split('/').map((s) => s.trim());
    const memUsedBytes = parseSizeToBytes(usedStr);
    const memLimit = parseSizeToBytes(limitStr);
    if (memLimit != null) memLimitBytes = memLimitBytes == null ? memLimit : Math.max(memLimitBytes, memLimit);
    byName.set(o.Name, {
      cpuPerc: pctToNum(o.CPUPerc),
      memUsedBytes,
      memLimitBytes: memLimit,
      memPerc: pctToNum(o.MemPerc),
      pids: o.PIDs ? parseInt(o.PIDs, 10) : null,
    });
  }
  return { byName, memLimitBytes };
}

// stdout of `docker system df --format '{{json .}}'`.
export function parseSystemDf(stdout) {
  const map = { Images: null, Containers: null, 'Local Volumes': null, 'Build Cache': null };
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.Type in map) map[o.Type] = parseSizeToBytes(o.Size);
  }
  const imagesBytes = map.Images, containersBytes = map.Containers, volumesBytes = map['Local Volumes'], buildCacheBytes = map['Build Cache'];
  const totalBytes = [imagesBytes, containersBytes, volumesBytes, buildCacheBytes].reduce((a, b) => a + (b || 0), 0);
  return { imagesBytes, containersBytes, volumesBytes, buildCacheBytes, totalBytes };
}

// stdout of `docker ps -a --size --format '{{json .}}'`.
export function parsePsSizes(stdout) {
  const byName = new Map();
  for (const line of String(stdout).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (!o.Names) continue;
    const m = String(o.Size || '').match(/^(.+?)\s*(?:\(virtual\s+(.+?)\))?$/);
    byName.set(o.Names, {
      sizeRwBytes: m ? parseSizeToBytes(m[1].trim()) : null,
      virtualBytes: m && m[2] ? parseSizeToBytes(m[2].trim()) : null,
    });
  }
  return byName;
}

// Per-machine popover payload (null card -> null; route turns that into 404).
export function shapeMachineStats({ card, statsEntry, sizeEntry, sampledAt, diskSampledAt, stale }) {
  if (!card) return null;
  return {
    name: card.name,
    state: card.state,
    exitCode: card.exitCode ?? null,
    cpuPerc: statsEntry?.cpuPerc ?? null,
    memUsedBytes: statsEntry?.memUsedBytes ?? null,
    memLimitBytes: statsEntry?.memLimitBytes ?? null,
    memPerc: statsEntry?.memPerc ?? null,
    pids: statsEntry?.pids ?? null,
    diskRwBytes: sizeEntry?.sizeRwBytes ?? null,
    diskVirtualBytes: sizeEntry?.virtualBytes ?? null,
    sampledAt: sampledAt ?? null,
    diskSampledAt: diskSampledAt ?? null,
    stale: !!stale,
  };
}

// Role-aware /api/resources payload. Non-admin payloads must never contain
// another user's name (unit-tested). `used` totals sum ALL containers so
// free-capacity is honest for everyone; clients derive an "other" bucket.
export function buildResourcesPayload({ user, cards, stats, df, sizes, vm, sampledAt, diskSampledAt, stale, dockerReachable }) {
  const panelCards = (cards || []).filter(isPanelMachine);
  const visible = filterMachinesForUser(panelCards, user);
  const isAdmin = user?.role === 'admin';

  const machines = visible.map((c) => {
    const s = stats?.byName?.get(c.name);
    const z = sizes?.get(c.name);
    const row = {
      name: c.name, state: c.state,
      cpuPerc: s?.cpuPerc ?? null, memBytes: s?.memUsedBytes ?? null,
      memPerc: s?.memPerc ?? null, diskRwBytes: z?.sizeRwBytes ?? null,
    };
    if (isAdmin) row.owner = c.owner || null; // owner key omitted entirely for non-admins
    return row;
  });

  // Capacity: prefer docker's cgroup limit (what the OOM killer enforces),
  // fall back to colima's provisioned memory when nothing is running.
  const dockerMem = stats?.memLimitBytes ?? null;
  const capMemBytes = dockerMem ?? vm?.memoryBytes ?? null;
  const memSource = dockerMem != null ? 'docker' : 'colima';

  let usedMem = null, usedCpu = null;
  if (stats?.byName && stats.byName.size) {
    usedMem = 0; usedCpu = 0;
    for (const s of stats.byName.values()) { usedMem += s.memUsedBytes || 0; usedCpu += s.cpuPerc || 0; }
  }
  const memPerc = capMemBytes && usedMem != null ? Math.round((usedMem / capMemBytes) * 1000) / 10 : null;

  return {
    vmRunning: !!vm?.running,
    dockerReachable: !!dockerReachable,
    capacity: {
      cpu: vm?.cpu ?? null,
      cpuPerc: vm?.cpu ? vm.cpu * 100 : null,
      memBytes: capMemBytes,
      memSource,
      provisionedMemBytes: vm?.memoryBytes ?? null,
      diskBytes: vm?.diskBytes ?? null,
    },
    used: {
      memBytes: usedMem,
      memPerc,
      cpuPerc: usedCpu == null ? null : Math.round(usedCpu * 10) / 10,
      disk: df || { imagesBytes: null, containersBytes: null, volumesBytes: null, buildCacheBytes: null, totalBytes: null },
    },
    machines,
    sampledAt: sampledAt ?? null,
    diskSampledAt: diskSampledAt ?? null,
    stale: stale || { stats: false, disk: false },
  };
}
