// Bring back the panel desktops that were running before a host reboot.
//
// Panel-created desktops use restart=on-failure (core.js buildRunArgs), and a
// clean shutdown stops them with exit 0, so Docker never restarts them. Before
// this, every patch reboot left users' desktops stopped until an administrator
// pressed Start, while the legacy unless-stopped desktops took the slots back.
//
// The maintenance tick records which panel machines are running, tagged with the
// kernel boot_id. On start-up, a record from a DIFFERENT boot means the host
// rebooted, so the machines it lists that are now stopped are started again, most
// recently used first, within the running-machine limit. A plain panel restart
// (same boot) or an explicit stop restores nothing.
import fs from 'node:fs';
import path from 'node:path';

export const LAST_RUNNING_FILE = 'last-running.json';

export function readLastRunning(dataDir) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(dataDir, LAST_RUNNING_FILE), 'utf8')); } catch { return null; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.names)) return null;
  return {
    bootId: typeof j.bootId === 'string' && j.bootId ? j.bootId : null,
    at: typeof j.at === 'string' ? j.at : null,
    names: j.names.filter((n) => typeof n === 'string' && n),
  };
}

// `names` in the order to restore (most recently active first).
export function lastRunningRecord(bootId, names, now = new Date()) {
  return { bootId: bootId || null, at: now.toISOString(), names: [...names] };
}

// The machines to start now. `cards` is the Map name -> card from the panel's
// docker snapshot; `isPanelMachine` limits this to panel-managed desktops.
export function planBootRestore(last, currentBootId, cards, { maxRunning = 0, isPanelMachine }) {
  if (!last || !last.bootId || !currentBootId || last.bootId === currentBootId) return [];
  const all = [...cards.values()];
  const running = all.filter((c) => isPanelMachine(c) && c.state === 'running').length;
  let free = maxRunning > 0 ? Math.max(0, maxRunning - running) : Infinity;
  const out = [];
  for (const name of last.names) {
    if (free <= 0) break;
    const card = cards.get(name);
    if (!card || !isPanelMachine(card) || card.state === 'running' || out.includes(name)) continue;
    // Docker restarts these itself; starting them here would race its restart.
    if (card.restartPolicy === 'always' || card.restartPolicy === 'unless-stopped') continue;
    out.push(name);
    free--;
  }
  return out;
}
