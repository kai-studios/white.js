// Easing and smoothing. Pure functions, no state.

export const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

// Frame-rate independent smoothing: moves `current` toward `target`.
// tau is the time constant in ms (smaller = snappier).
export const approach = (current, target, dtMs, tau = 110) =>
  current + (target - current) * (1 - Math.exp(-dtMs / tau));

export const mixRgb = (a, b, t) => [
  Math.round(lerp(a[0], b[0], t)),
  Math.round(lerp(a[1], b[1], t)),
  Math.round(lerp(a[2], b[2], t)),
];

// Color at position t (0..1) along a list of rgb stops
export function sample(stops, t) {
  if (stops.length === 1) return stops[0];
  const x = clamp(t) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  return mixRgb(stops[i], stops[i + 1], x - i);
}
