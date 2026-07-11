// Boot-time cleanup of stale scratch files. A crash mid-upload leaves a
// `vmp-*` temp in os.tmpdir(); without a sweep they accumulate forever. Pure
// enough to unit-test: pass a dir, prefix, max age, and clock.

import fs from 'node:fs';
import path from 'node:path';

// Remove files under `dir` whose name starts with `prefix` and whose mtime is
// older than `maxAgeMs`. Best-effort: unreadable dir or files are skipped, never
// thrown. Returns the list of removed names.
export function sweepStale(dir, prefix, maxAgeMs, now = Date.now()) {
  const removed = [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return removed; }
  const cutoff = now - maxAgeMs;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(p); removed.push(name); }
    } catch { /* file vanished or unreadable — skip */ }
  }
  return removed;
}
