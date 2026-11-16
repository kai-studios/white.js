import { clamp, sample } from '../core/ease.js';
import { caps } from '../core/ansi.js';
import { rgb, sym, t } from '../core/theme.js';
import { paintChar } from './gradient.js';

// Progress bar with 1/8-cell resolution, so a fractional value moves smoothly
// instead of jumping a whole cell at a time. value: 0..1 (can be fractional).
export function progressBar(value, { width = 28, label = true } = {}) {
  const v = clamp(value);
  const exact = v * width;
  const full = Math.floor(exact);
  const partial = sym.barPartial[Math.floor((exact - full) * sym.barPartial.length)] ?? '';

  const paint = (ch, i) =>
    caps.depth >= 24 ? paintChar(ch, sample(rgb.gradient.slice(1), i / Math.max(1, width - 1))) : t.accent(ch);

  let bar = '';
  for (let i = 0; i < full; i++) bar += paint(sym.barFull, i);
  if (partial && full < width) bar += paint(partial, full);
  const used = full + (partial && full < width ? 1 : 0);
  bar += t.muted(sym.barTrack.repeat(width - used));

  return label ? `${bar}  ${t.muted(String(Math.round(v * 100)).padStart(3) + '%')}` : bar;
}
