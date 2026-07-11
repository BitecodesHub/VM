// Zero-dependency SVG charts. Geometry lives here; colors come from CSS classes
// on the existing design tokens (see style.css .c-* / .seg-*), so the palette
// stays in one place and light/dark both work.
import { esc } from './ui.js';

export function fmtBytes(n, { binary = true, digits = 1 } = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  const base = binary ? 1024 : 1000;
  const units = binary ? ['B', 'KiB', 'MiB', 'GiB', 'TiB'] : ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= base && i < units.length - 1) { v /= base; i++; }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}
export function fmtPct(n) { return n == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 10) / 10}%`; }

const W = 640, ROW = 30, PAD = 8, LABEL_W = 168, BAR_X = LABEL_W, BAR_W = W - LABEL_W - 64, BAR_H = 12;

// rows: [{ label, sublabel?, value, valueText, level: null|'warn'|'crit' }]
// Single-measure magnitude: one hue; `level` promotes a bar to a warn/crit state.
export function hBarChart({ rows, max, ariaLabel }) {
  if (!rows.length) return '<p class="chart-empty">No machines running.</p>';
  const safeMax = max > 0 ? max : 1;
  const h = rows.length * ROW + PAD;
  const parts = rows.map((r, i) => {
    const y = i * ROW + PAD;
    const w = Math.max(2, Math.min(BAR_W, (r.value / safeMax) * BAR_W));
    const cls = r.level === 'crit' ? ' crit' : r.level === 'warn' ? ' warn' : '';
    const label = esc(r.label).length > 22 ? esc(r.label).slice(0, 21) + '…' : esc(r.label);
    const sub = r.sublabel ? `<tspan class="c-owner"> · ${esc(r.sublabel)}</tspan>` : '';
    const inside = w > BAR_W - 60;
    const valX = inside ? BAR_X + w - 6 : BAR_X + w + 6;
    const valAnchor = inside ? 'end' : 'start';
    return `<title>${esc(r.label)} — ${esc(r.valueText)}</title>
      <text class="c-label" x="0" y="${y + BAR_H / 2 + 4}">${label}${sub}</text>
      <rect class="c-track" x="${BAR_X}" y="${y}" width="${BAR_W}" height="${BAR_H}" rx="6"/>
      <rect class="c-fill${cls}" x="${BAR_X}" y="${y}" width="${w}" height="${BAR_H}" rx="6"/>
      <text class="c-val" x="${valX}" y="${y + BAR_H / 2 + 4}" text-anchor="${valAnchor}">${esc(r.valueText)}</text>`;
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(ariaLabel)}" preserveAspectRatio="xMinYMin meet">${parts}</svg>`;
}

// segments: [{ label, value, cls: 'seg-images'|'seg-containers'|'seg-volumes'|'seg-cache'|'seg-free' }]
export function stackedBar({ segments, total, ariaLabel }) {
  const sum = total || segments.reduce((a, s) => a + (s.value || 0), 0) || 1;
  let x = 0;
  const H = 22;
  const rects = segments.filter((s) => s.value > 0).map((s) => {
    const w = (s.value / sum) * W;
    const r = `<rect class="c-seg ${s.cls}" x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - 2).toFixed(1)}" height="${H}" rx="3"><title>${esc(s.label)}: ${fmtBytes(s.value)}</title></rect>`;
    x += w;
    return r;
  }).join('');
  const svg = `<svg class="chart-svg stacked" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}" preserveAspectRatio="none">${rects}</svg>`;
  const legend = `<div class="legend">${segments.map((s) => `<span class="legend-item"><span class="legend-swatch ${s.cls}"></span>${esc(s.label)} <b>${fmtBytes(s.value)}</b></span>`).join('')}</div>`;
  return { svg, legend };
}
