// Pure aggregation over the usage-session ledger. Given the closed session rows
// (from UsageSessionStore.closedList) and the currently-live sessions
// (liveList), produce the summary that the admin Usage tab and the PRISM
// analytics view both render. Kept dependency-free and side-effect-free so it is
// trivially unit-testable and reusable server-side for the /api/ext feed.

function round2(n) { return Math.round(n * 100) / 100; }
function hoursOf(sec) { return round2(sec / 3600); }

export function summariseSessions(closed = [], live = [], { now = Date.now(), days = 30 } = {}) {
  const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 0;
  // Align the window to UTC calendar days so the totals filter and the daily
  // series cover exactly the same span (avoids an off-by-one between them).
  const startDayMs = windowDays ? Date.parse(`${new Date(now - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`) : 0;
  const sinceMs = startDayMs;
  const rows = sinceMs ? closed.filter((r) => (Date.parse(r.endedAt) || 0) >= sinceMs) : closed.slice();

  const byUser = new Map();
  const byMachine = new Map();
  const byUserMachine = new Map();
  const dayBuckets = new Map();
  let totalSeconds = 0;

  for (const r of rows) {
    const dur = Math.max(0, Number(r.durationSec) || 0);
    const endMs = Date.parse(r.endedAt) || now;
    totalSeconds += dur;

    const u = byUser.get(r.user) || { user: r.user, sessions: 0, seconds: 0, machines: new Set(), lastAt: 0 };
    u.sessions += 1; u.seconds += dur; u.machines.add(r.machine); u.lastAt = Math.max(u.lastAt, endMs);
    byUser.set(r.user, u);

    const m = byMachine.get(r.machine) || { machine: r.machine, template: r.template || null, owner: r.owner || null, sessions: 0, seconds: 0, users: new Set(), lastAt: 0 };
    m.sessions += 1; m.seconds += dur; m.users.add(r.user); m.lastAt = Math.max(m.lastAt, endMs);
    if (!m.template && r.template) m.template = r.template;
    if (!m.owner && r.owner) m.owner = r.owner;
    byMachine.set(r.machine, m);

    const kum = `${r.user} ${r.machine}`;
    const um = byUserMachine.get(kum) || { user: r.user, machine: r.machine, sessions: 0, seconds: 0, lastAt: 0 };
    um.sessions += 1; um.seconds += dur; um.lastAt = Math.max(um.lastAt, endMs);
    byUserMachine.set(kum, um);

    const day = typeof r.endedAt === 'string' ? r.endedAt.slice(0, 10) : new Date(endMs).toISOString().slice(0, 10);
    dayBuckets.set(day, (dayBuckets.get(day) || 0) + dur);
  }

  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const byUserOut = [...byUser.values()]
    .map((u) => ({ user: u.user, sessions: u.sessions, seconds: u.seconds, hours: hoursOf(u.seconds), machines: u.machines.size, lastAt: iso(u.lastAt) }))
    .sort((a, b) => b.seconds - a.seconds);
  const byMachineOut = [...byMachine.values()]
    .map((m) => ({ machine: m.machine, template: m.template, owner: m.owner, sessions: m.sessions, seconds: m.seconds, hours: hoursOf(m.seconds), users: m.users.size, lastAt: iso(m.lastAt) }))
    .sort((a, b) => b.seconds - a.seconds);
  const byUserMachineOut = [...byUserMachine.values()]
    .map((x) => ({ user: x.user, machine: x.machine, sessions: x.sessions, seconds: x.seconds, hours: hoursOf(x.seconds), lastAt: iso(x.lastAt) }))
    .sort((a, b) => b.seconds - a.seconds);

  // Zero-filled daily series over the window, oldest-first.
  const daily = [];
  if (windowDays) {
    for (let i = 0; i < windowDays; i++) {
      const date = new Date(startDayMs + i * 86_400_000).toISOString().slice(0, 10);
      const sec = dayBuckets.get(date) || 0;
      daily.push({ date, seconds: sec, hours: hoursOf(sec) });
    }
  }

  // Peak concurrency: sweep-line over [start, end] intervals. At an equal
  // timestamp, process ends (-1) before starts (+1) so a clean handoff is not
  // counted as an overlap. Ongoing live sessions floor the peak.
  const events = [];
  for (const r of rows) {
    const a = Date.parse(r.startedAt), b = Date.parse(r.endedAt);
    if (Number.isFinite(a) && Number.isFinite(b)) { events.push([a, 1]); events.push([b, -1]); }
  }
  // Live sessions are open intervals [startedAt, now]; include them so peak
  // concurrency counts current viewers that overlap recently-closed sessions.
  for (const s of live) {
    const a = Date.parse(s.startedAt);
    if (Number.isFinite(a)) { events.push([a, 1]); events.push([now, -1]); }
  }
  events.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]));
  let cur = 0, peak = 0;
  for (const [, delta] of events) { cur += delta; if (cur > peak) peak = cur; }
  peak = Math.max(peak, live.length);

  const liveSeconds = live.reduce((acc, s) => acc + Math.max(0, Number(s.durationSec) || 0), 0);
  const activeUsers = new Set(live.map((s) => s.user)).size;

  return {
    range: { days: windowDays, sinceMs, now },
    totals: {
      sessions: rows.length,
      seconds: totalSeconds,
      hours: hoursOf(totalSeconds),
      users: byUser.size,
      machines: byMachine.size,
      avgSessionSec: rows.length ? Math.round(totalSeconds / rows.length) : 0,
      peakConcurrency: peak,
      activeNow: live.length,
      activeUsers,
      liveSeconds,
    },
    byUser: byUserOut,
    byMachine: byMachineOut,
    byUserMachine: byUserMachineOut,
    daily,
    // Never surface raw client IPs to analytics viewers (view_vm_analytics is
    // broader than admin) — expose only who/what/how-long.
    active: live.map((s) => ({ id: s.id, user: s.user, machine: s.machine, template: s.template, owner: s.owner, startedAt: s.startedAt, durationSec: s.durationSec })),
  };
}
