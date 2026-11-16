const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// duration('5m') -> 300000, duration(1500) -> 1500, duration('1.5h') -> 5400000.
// Numbers are milliseconds.
export function duration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i.exec(String(value).trim());
  if (!match) throw new TypeError(`Invalid duration: ${JSON.stringify(value)}. Use 1500 or "30s", "5m", "1h", "1d".`);
  return Math.round(Number(match[1]) * UNITS[match[2].toLowerCase()]);
}
