import { caps, fgCode } from '../core/ansi.js';
import { sample } from '../core/ease.js';
import { rgb, t } from '../core/theme.js';

// Paints one character with an rgb color
export const paintChar = (ch, c) => {
  const code = fgCode(c);
  return code ? `\x1b[${code}m${ch}\x1b[39m` : ch;
};

// Horizontal gradient over a string. Without truecolor it falls back to one accent color.
export function gradient(text, stops = rgb.gradient) {
  if (caps.depth < 24) return t.accent(text);
  const chars = [...text];
  const last = Math.max(1, chars.length - 1);
  return chars.map((ch, i) => (ch === ' ' ? ch : paintChar(ch, sample(stops, i / last)))).join('');
}
