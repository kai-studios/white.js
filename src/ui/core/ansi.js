// Low-level terminal helpers: capability detection, colors, string width.
// Zero dependencies. Everything here is cheap and safe to import on every start.
import process from 'node:process';

const { env } = process;

function colorDepth(stream) {
  const force = env.FORCE_COLOR;
  if (force === '0' || force === 'false') return 0;
  if (force === undefined) {
    if ('NO_COLOR' in env && env.NO_COLOR !== '') return 0;
    if (env.TERM === 'dumb' || !stream.isTTY) return 0;
  }
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit' || force === '3') return 24;
  if (process.platform === 'win32' || env.WT_SESSION) return 24;
  if (['vscode', 'iTerm.app', 'WezTerm', 'ghostty', 'Hyper'].includes(env.TERM_PROGRAM)) return 24;
  if (force === '2' || /256/.test(env.TERM ?? '')) return 8;
  return 4;
}

function supportsUnicode() {
  if (process.platform !== 'win32') return env.TERM !== 'linux';
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuTask || env.TERM === 'xterm-256color');
}

export const caps = {
  depth: colorDepth(process.stdout), // 0 none, 4 basic, 8 = 256, 24 = truecolor
  unicode: supportsUnicode(),
  // Live (animated) output needs a real terminal
  interactive: Boolean(process.stdout.isTTY && process.stdin.isTTY && env.TERM !== 'dumb' && !env.CI),
  // Decorative motion (logo reveal, fades) can be turned off; spinners always run
  motion: !('WHITE_NO_ANIMATION' in env) && !('NO_MOTION' in env) && env.REDUCE_MOTION !== '1',
};

// ── Colors ────────────────────────────────────────────────────────────────

export const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

function rgbTo256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v) => Math.round((v / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function rgbTo16([r, g, b]) {
  const v = Math.max(r, g, b);
  if (v < 50) return 30;
  const bits = (b > v * 0.6 ? 4 : 0) | (g > v * 0.6 ? 2 : 0) | (r > v * 0.6 ? 1 : 0);
  if (bits === 0 || bits === 7) return v > 170 ? 97 : 90;
  return (v > 170 ? 90 : 30) + bits;
}

// SGR parameters for a foreground color, or '' when colors are off
export function fgCode(rgb) {
  switch (caps.depth) {
    case 24:
      return `38;2;${rgb[0]};${rgb[1]};${rgb[2]}`;
    case 8:
      return `38;5;${rgbTo256(rgb)}`;
    case 4:
      return String(rgbTo16(rgb));
    default:
      return '';
  }
}
const sgr = (open, close) => (text) => (caps.depth ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));

export const bold = sgr(1, 22);
export const dim = sgr(2, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);
export const inverse = sgr(7, 27);

// color('#7dd3fc') -> (text) => painted text
export function color(hex) {
  const code = fgCode(hexToRgb(hex));
  return (text) => (code ? `\x1b[${code}m${text}\x1b[39m` : String(text));
}

// ── Cursor / screen ───────────────────────────────────────────────────────

export const cursor = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  up: (n) => (n > 0 ? `\x1b[${n}A` : ''),
  eraseLine: '\x1b[2K',
  eraseDown: '\x1b[J',
  syncStart: '\x1b[?2026h', // synchronized output: the terminal paints the frame atomically
  syncEnd: '\x1b[?2026l',
};

// ── Measuring ─────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const strip = (s) => String(s).replace(ANSI_RE, '');

function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

// Visible width of a string (ANSI codes are free, CJK/emoji count double)
export function width(s) {
  let w = 0;
  for (const ch of strip(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

// Cuts a string to `max` visible columns without breaking escape sequences
export function truncate(s, max, tail = '…') {
  if (width(s) <= max) return s;
  const limit = Math.max(0, max - width(tail));
  let out = '';
  let used = 0;
  for (const part of String(s).split(/(\x1b\[[0-9;?]*[ -/]*[@-~])/)) {
    if (part.startsWith('\x1b')) {
      out += part;
      continue;
    }
    for (const ch of part) {
      const w = charWidth(ch.codePointAt(0));
      if (used + w > limit) return out + tail + (caps.depth ? '\x1b[0m' : '');
      out += ch;
      used += w;
    }
  }
  return out;
}

export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
