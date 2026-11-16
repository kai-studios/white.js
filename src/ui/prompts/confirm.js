import { sym, t, rail } from '../core/theme.js';
import { runPrompt, activeHead, doneLine, cancelLine, spacer, fade } from './run.js';

// Yes / No: ← → or y / n toggle, Enter confirms.
export function confirm({ message, initial = true, yes = 'Yes', no = 'No' }) {
  return runPrompt(({ submit, cancel }) => {
    let value = initial;
    let since = -Infinity;
    let now = 0;

    const set = (next) => {
      if (next !== value) since = now;
      value = next;
    };
    const option = (on, label, elapsed) =>
      on ? `${t.accent(sym.radioOn)} ${fade(label, elapsed, since)}` : `${t.muted(sym.radioOff)} ${t.muted(label)}`;

    return {
      draw(elapsed) {
        now = elapsed;
        return [activeHead(message), rail(`${option(value, yes, elapsed)}   ${option(!value, no, elapsed)}`), spacer()];
      },

      key(str, key) {
        if (key.name === 'left' || key.name === 'right' || key.name === 'tab' || str === 'h' || str === 'l') set(!value);
        else if (str === 'y' || str === 'Y') set(true);
        else if (str === 'n' || str === 'N') set(false);
        else if (key.name === 'return' || key.name === 'enter') {
          submit(value, [doneLine(message, value ? yes : no), spacer()]);
        }
      },

      onCancel: () => cancel([cancelLine(message), spacer()]),
    };
  });
}
