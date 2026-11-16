import process from 'node:process';
import { inverse } from '../core/ansi.js';
import { sym, t, rail } from '../core/theme.js';
import { runPrompt, activeHead, doneLine, cancelLine, spacer } from './run.js';

const SHAKE = [2, 0, 2, 0, 1, 0]; // columns, one step per 45ms
const isPrintable = (str) => str && !/[\x00-\x1f\x7f]/.test(str);

// Single-line input: cursor movement, word delete, live validation, a nudge on invalid submit.
//   text({ message, placeholder, initial, validate(value) -> string|undefined, hint(value) -> string })
export function text({ message, placeholder = '', initial = '', validate, hint }) {
  return runPrompt(({ submit, cancel }) => {
    let value = initial;
    let pos = [...value].length;
    let shakeAt = -Infinity;
    let now = 0;

    const current = () => value.trim() || placeholder;
    const problem = () => validate?.(current());

    const field = (columns) => {
      const chars = [...value];
      if (!chars.length) {
        const [first = '', ...rest] = [...placeholder];
        return inverse(first || ' ') + t.muted(rest.join(''));
      }
      // keep the cursor visible in a window when the text is longer than the line
      const room = Math.max(10, columns - 12);
      const start = Math.max(0, Math.min(pos - room + 1, chars.length - room));
      const shown = chars.slice(start, start + room);
      const at = pos - start;
      return (
        t.text(shown.slice(0, at).join('')) +
        inverse(shown[at] ?? ' ') +
        t.text(shown.slice(at + 1).join(''))
      );
    };

    return {
      draw(elapsed) {
        now = elapsed;
        const step = Math.floor((elapsed - shakeAt) / 45);
        const nudge = ' '.repeat(SHAKE[step] ?? 0);
        const err = problem();
        const note = err
          ? t.error(`${sym.arrow} ${err}`)
          : hint
            ? t.muted(`${sym.arrow} ${hint(current())}`)
            : '';
        const lines = [activeHead(message), rail(nudge + field(process.stdout.columns || 80)), ...(note ? [rail(note)] : []), spacer()];
        return lines;
      },

      key(str, key) {
        if (key.name === 'return' || key.name === 'enter') {
          if (problem()) {
            shakeAt = now;
            return;
          }
          return submit(current(), [doneLine(message, current()), spacer()]);
        }
        const chars = [...value];
        const edit = (next, nextPos) => {
          value = next.join('');
          pos = nextPos;
        };
        if (key.name === 'left') pos = Math.max(0, pos - 1);
        else if (key.name === 'right') pos = Math.min(chars.length, pos + 1);
        else if (key.name === 'home' || (key.ctrl && key.name === 'a')) pos = 0;
        else if (key.name === 'end' || (key.ctrl && key.name === 'e')) pos = chars.length;
        else if (key.name === 'backspace') {
          if (pos > 0) edit([...chars.slice(0, pos - 1), ...chars.slice(pos)], pos - 1);
        } else if (key.name === 'delete') {
          if (pos < chars.length) edit([...chars.slice(0, pos), ...chars.slice(pos + 1)], pos);
        } else if (key.ctrl && key.name === 'u') edit(chars.slice(pos), 0);
        else if (key.ctrl && key.name === 'w') {
          let i = pos;
          while (i > 0 && chars[i - 1] === ' ') i--;
          while (i > 0 && chars[i - 1] !== ' ') i--;
          edit([...chars.slice(0, i), ...chars.slice(pos)], i);
        } else if (isPrintable(str) && !key.ctrl && !key.meta) {
          const add = [...str];
          edit([...chars.slice(0, pos), ...add, ...chars.slice(pos)], pos + add.length);
        }
      },

      onCancel: () => cancel([cancelLine(message), spacer()]),
    };
  });
}
