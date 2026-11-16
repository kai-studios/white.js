import { Live } from '../core/live.js';
import { readKeys, CancelError } from '../core/input.js';
import { easeOutCubic, clamp, mixRgb } from '../core/ease.js';
import { rgb, sym, t, rail } from '../core/theme.js';
import { fgCode } from '../core/ansi.js';

// Shared lifecycle of every prompt: live block + key handling + cleanup.
//
// make({ submit, cancel, live }) returns { draw(elapsed, dt), key(str, key) }.
// draw() returns the lines of the active state; submit(value, lines) freezes the
// answer as a one-line summary and resolves the promise.
export function runPrompt(make) {
  return new Promise((resolve, reject) => {
    const live = new Live();
    let stopKeys = () => {};

    const finish = (lines, settle) => {
      stopKeys();
      live.stop(lines);
      settle();
    };

    const prompt = make({
      live,
      submit: (value, lines) => finish(lines, () => resolve(value)),
      cancel: (lines) => finish(lines, () => reject(new CancelError())),
    });

    stopKeys = readKeys((str, key) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        return prompt.onCancel();
      }
      prompt.key(str, key);
      live.refresh(); // react to the key now, not on the next frame
    });
    live.start((elapsed, dt) => prompt.draw(elapsed, dt));
  });
}

// ── Pieces shared by prompts ──────────────────────────────────────────────

export const head = (symbol, message) => `  ${symbol}  ${t.bold(message)}`;
export const activeHead = (message) => head(t.accent(sym.active), message);
export const doneLine = (message, value) => `  ${t.accent(sym.done)}  ${t.muted(message)}  ${t.text(value)}`;
export const cancelLine = (message) => `  ${t.error(sym.cancel)}  ${t.muted(message)}  ${t.error('cancelled')}`;
export const spacer = () => rail();

// Fades a color from muted to text over `ms` since `since` (no-op without truecolor)
export function fade(text, elapsed, since, ms = 140) {
  const p = easeOutCubic(clamp((elapsed - since) / ms));
  const code = fgCode(mixRgb(rgb.muted, rgb.text, p));
  return code && p < 1 ? `\x1b[${code}m${text}\x1b[39m` : t.text(text);
}
