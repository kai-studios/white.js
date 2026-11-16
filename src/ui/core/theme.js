// One place for the look: palette, text styles and symbols.
import { caps, color, bold, dim, hexToRgb } from './ansi.js';

export const palette = {
  accent: '#7dd3fc',
  success: '#86efac',
  warn: '#fde68a',
  error: '#fca5a5',
  muted: '#6b7280',
  text: '#f8fafc',
  // logo / progress gradient, left to right
  gradient: ['#f8fafc', '#a5f3fc', '#a5b4fc', '#f0abfc'],
};

export const rgb = {
  accent: hexToRgb(palette.accent),
  success: hexToRgb(palette.success),
  error: hexToRgb(palette.error),
  muted: hexToRgb(palette.muted),
  text: hexToRgb(palette.text),
  gradient: palette.gradient.map(hexToRgb),
};

export const t = {
  accent: color(palette.accent),
  success: color(palette.success),
  warn: color(palette.warn),
  error: color(palette.error),
  muted: color(palette.muted),
  text: color(palette.text),
  bold,
  dim,
};

const unicode = {
  intro: '┌',
  outro: '└',
  rail: '│',
  active: '◆',
  done: '◇',
  fail: '▲',
  cancel: '■',
  info: '●',
  ok: '✔',
  err: '✖',
  radioOn: '●',
  radioOff: '○',
  pending: '○',
  noteTop: '╮',
  noteBottom: '╯',
  noteSide: '│',
  noteJoin: '├',
  hline: '─',
  arrow: '↳',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  barFull: '█',
  barPartial: ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'],
  barTrack: '░',
};

const ascii = {
  intro: '+',
  outro: '+',
  rail: '|',
  active: '*',
  done: 'o',
  fail: '!',
  cancel: 'x',
  info: '*',
  ok: 'v',
  err: 'x',
  radioOn: '(*)',
  radioOff: '( )',
  pending: '.',
  noteTop: '+',
  noteBottom: '+',
  noteSide: '|',
  noteJoin: '+',
  hline: '-',
  arrow: '>',
  spinner: ['-', '\\', '|', '/'],
  barFull: '#',
  barPartial: [''],
  barTrack: '-',
};

export const sym = caps.unicode ? unicode : ascii;

export const MARGIN = '  ';
export const rail = (text = '') => `${MARGIN}${t.muted(sym.rail)}${text ? '  ' + text : ''}`;
