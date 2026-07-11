// Pure client-side search + sort for the machine list. DOM-free so it can be
// unit-tested under node and reused by the view without pulling in ui.js.

const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });

const COMPARATORS = {
  name: byName,
  state: (a, b) => String(a.state).localeCompare(String(b.state)) || byName(a, b),
  // Newest first; unstarted (no startedAt) sinks to the bottom, then by name.
  created: (a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0) || byName(a, b),
};

export const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'state', label: 'Status' },
  { value: 'created', label: 'Newest' },
];

// Filter by a free-text query (name / type / owner / status), then sort.
export function filterSortMachines(list, { q = '', sort = 'name' } = {}) {
  let out = Array.isArray(list) ? list : [];
  const needle = String(q).trim().toLowerCase();
  if (needle) {
    out = out.filter((m) => `${m.name} ${m.templateLabel || ''} ${m.owner || ''} ${m.statusText || ''}`.toLowerCase().includes(needle));
  }
  return [...out].sort(COMPARATORS[sort] || byName);
}
