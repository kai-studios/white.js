// Framing of a CLI session: intro, outro, log lines and the "note" box.
// Everything shares one vertical rail, so consecutive pieces read as a single flow.
import { caps, pad, width } from './core/ansi.js';
import { sym, t, rail, MARGIN } from './core/theme.js';
import { playLogo, logoLines } from './components/logo.js';

const out = (lines) => console.log(lines.join('\n'));

export async function intro(title) {
  if (caps.interactive) await playLogo();
  else out(logoLines());
  out(['', `${MARGIN}${t.muted(sym.intro)}  ${title}`, rail()]);
}

export function outro(message) {
  out([`${MARGIN}${t.muted(sym.outro)}  ${message}`, '']);
}

export const log = {
  info: (m) => out([`${MARGIN}${t.accent(sym.info)}  ${m}`, rail()]),
  success: (m) => out([`${MARGIN}${t.success(sym.ok)}  ${m}`, rail()]),
  warn: (m) => out([`${MARGIN}${t.warn(sym.fail)}  ${m}`, rail()]),
  error: (m) => out([`${MARGIN}${t.error(sym.err)}  ${m}`, rail()]),
};

// Boxed block hanging off the rail:
//   ◇  Next steps ─────╮
//   │                  │
//   │  cd my-site      │
//   ├──────────────────╯
export function note(title, lines) {
  const W = Math.max(width(title) + 1, ...lines.map((l) => width(l)));
  const bar = t.muted(sym.noteSide);
  const top = `${MARGIN}${t.accent(sym.done)}  ${t.text(title)} ${t.muted(sym.hline.repeat(W + 1 - width(title)) + sym.noteTop)}`;
  const blank = `${rail()}${' '.repeat(W + 4)}${bar}`;
  const rows = lines.map((l) => `${rail(pad(l, W))}  ${bar}`);
  const bottom = `${MARGIN}${t.muted(sym.noteJoin + sym.hline.repeat(W + 4) + sym.noteBottom)}`;
  out([top, blank, ...rows, blank, bottom, rail()]);
}
