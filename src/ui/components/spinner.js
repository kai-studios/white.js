import { sym, t } from '../core/theme.js';

// The frame depends on elapsed time, not on a counter, so every spinner stays in step
// no matter how often (or how late) it is drawn.
export function spinner(elapsedMs, intervalMs = 80) {
  const frames = sym.spinner;
  return t.accent(frames[Math.floor(elapsedMs / intervalMs) % frames.length]);
}
