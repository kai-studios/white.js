import { sym, t, rail } from '../core/theme.js';
import { runPrompt, activeHead, doneLine, cancelLine, spacer, fade } from './run.js';

// Pick one option with arrows / j k / number keys. The newly active row fades in.
//   select({ message, options: [{ value, label, hint }], initial })
export function select({ message, options, initial = 0 }) {
  return runPrompt(({ submit, cancel }) => {
    let index = Math.min(Math.max(0, initial), options.length - 1);
    let since = -Infinity;
    let now = 0;

    const move = (to) => {
      index = (to + options.length) % options.length;
      since = now;
    };

    return {
      draw(elapsed) {
        now = elapsed;
        const rows = options.map((o, i) => {
          const hint = o.hint ? '  ' + t.muted(o.hint) : '';
          if (i !== index) return rail(`${t.muted(sym.radioOff)} ${t.muted(o.label ?? o.value)}${hint}`);
          const label = fade(o.label ?? o.value, elapsed, since);
          return rail(`${t.accent(sym.radioOn)} ${label}${hint}`);
        });
        return [activeHead(message), ...rows, spacer()];
      },

      key(str, key) {
        if (key.name === 'up' || str === 'k') move(index - 1);
        else if (key.name === 'down' || str === 'j' || key.name === 'tab') move(index + 1);
        else if (/^[1-9]$/.test(str ?? '') && Number(str) <= options.length) move(Number(str) - 1);
        else if (key.name === 'return' || key.name === 'enter') {
          const chosen = options[index];
          submit(chosen.value, [doneLine(message, chosen.label ?? chosen.value), spacer()]);
        }
      },

      onCancel: () => cancel([cancelLine(message), spacer()]),
    };
  });
}
