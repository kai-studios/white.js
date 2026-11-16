import process from 'node:process';
import { caps } from '../core/ansi.js';
import { Live } from '../core/live.js';
import { easeOutCubic, mixRgb, sample, clamp } from '../core/ease.js';
import { rgb, t, MARGIN } from '../core/theme.js';
import { gradient, paintChar } from './gradient.js';

const LOGO = [
  '██╗    ██╗██╗  ██╗██╗████████╗███████╗        ██╗███████╗',
  '██║    ██║██║  ██║██║╚══██╔══╝██╔════╝        ██║██╔════╝',
  '██║ █╗ ██║███████║██║   ██║   █████╗          ██║███████╗',
  '██║███╗██║██╔══██║██║   ██║   ██╔══╝     ██   ██║╚════██║',
  '╚███╔███╔╝██║  ██║██║   ██║   ███████╗██╗╚█████╔╝███████║',
  ' ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝   ╚═╝   ╚══════╝╚═╝ ╚════╝ ╚══════╝',
];
const LOGO_WIDTH = 58;
const COMPACT = 'White.js';

// The big logo needs ~62 columns; narrow terminals get a one-line wordmark
const fits = (columns = process.stdout.columns || 80) => caps.unicode && columns >= LOGO_WIDTH + MARGIN.length * 2;

export function logoLines() {
  if (!fits()) return [MARGIN + t.bold(gradient(COMPACT))];
  return LOGO.map((line) => MARGIN + gradient(line));
}

// A bright front sweeps left to right and reveals the logo (~0.5s).
// Skipped on dumb terminals, without truecolor, and when motion is disabled.
export async function playLogo({ duration = 520 } = {}) {
  const live = new Live({ fps: 60 });
  const final = logoLines();
  if (!live.enabled || !caps.motion || caps.depth < 24 || !fits()) {
    live.stop(final);
    return;
  }

  const trail = 9;
  const white = rgb.text;
  await new Promise((resolve) => {
    live.start((elapsed) => {
      const p = clamp(elapsed / duration);
      if (p >= 1) {
        queueMicrotask(resolve);
        return final;
      }
      const front = easeOutCubic(p) * (LOGO_WIDTH + trail);
      return LOGO.map((line) => {
        let out = MARGIN;
        let col = 0;
        for (const ch of line) {
          const behind = front - col;
          if (ch === ' ' || behind < 0) {
            out += ' ';
          } else {
            const base = sample(rgb.gradient, col / (LOGO_WIDTH - 1));
            out += paintChar(ch, mixRgb(base, white, clamp(1 - behind / trail)));
          }
          col++;
        }
        return out;
      });
    });
  });
  live.stop(final);
}
