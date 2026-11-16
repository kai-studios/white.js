import { Live } from './core/live.js';
import { approach, clamp } from './core/ease.js';
import { caps } from './core/ansi.js';
import { sym, t, rail } from './core/theme.js';
import { spinner } from './components/spinner.js';
import { progressBar } from './components/progress.js';

const fmtTime = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

// Runs steps one after another with a live checklist.
//
//   await tasks('Setting up', [
//     { title: 'Download', run: async ({ progress, message }) => { progress(0.5); message('3 MB'); } },
//     { title: 'Install', skip: !wanted, run: async () => {} },
//   ]);
//
// progress(0..1) shows a bar that eases toward the value; message(text) shows a dim status
// next to the running step. A step that throws is marked failed and the error is rethrown.
export async function tasks(title, steps) {
  const items = steps
    .filter((s) => !s.skip)
    .map((s) => ({ title: s.title, run: s.run, state: 'pending', target: null, shown: 0, note: '', ms: 0 }));

  const started = performance.now();
  const live = new Live();

  const frame = (elapsed, dt) =>
    [
      `  ${t.accent(sym.active)}  ${t.bold(title)}`,
      ...items.flatMap((item) => row(item, elapsed, dt)),
      rail(),
    ];

  function row(item, elapsed, dt) {
    const { state } = item;
    if (state === 'pending') return [rail(`${t.muted(sym.pending)} ${t.muted(item.title)}`)];
    if (state === 'done') return [rail(`${t.success(sym.ok)} ${item.title}  ${t.muted(fmtTime(item.ms))}`)];
    if (state === 'failed') return [rail(`${t.error(sym.err)} ${item.title}`)];

    // running
    const note = item.note ? '  ' + t.muted(item.note) : '';
    const lines = [rail(`${spinner(elapsed)} ${item.title}${note}`)];
    if (item.target !== null) {
      item.shown = approach(item.shown, item.target, dt, 110);
      lines.push(rail('  ' + progressBar(item.shown)));
    }
    return lines;
  }

  if (!live.enabled) return plain(title, items);

  live.start(frame);
  try {
    for (const item of items) {
      item.state = 'running';
      const t0 = performance.now();
      const handle = {
        progress: (v) => (item.target = Math.max(item.target ?? 0, clamp(v))),
        message: (text) => (item.note = String(text ?? '').replace(/\s+/g, ' ').trim()),
      };
      try {
        await item.run(handle);
        item.ms = performance.now() - t0;
        item.state = 'done';
      } catch (error) {
        item.state = 'failed';
        throw error;
      }
    }
  } finally {
    const ok = items.every((i) => i.state === 'done');
    const lines = frame(live.last - live.t0, 0).map((l, i) =>
      i === 0 && ok ? `  ${t.accent(sym.done)}  ${t.muted(title)}  ${t.muted(fmtTime(performance.now() - started))}` : l,
    );
    live.stop(lines);
  }
}

// No terminal: simple lines that read well in logs
async function plain(title, items) {
  console.log(title);
  for (const item of items) {
    const t0 = performance.now();
    let last = -1;
    console.log(`- ${item.title}...`);
    const handle = {
      progress: (v) => {
        const pct = Math.floor(clamp(v) * 10) * 10;
        if (pct > last && pct > 0) console.log(`  ${pct}%`);
        last = Math.max(last, pct);
      },
      message: () => {},
    };
    await item.run(handle);
    console.log(`  ${caps.unicode ? '✔' : 'done'} ${fmtTime(performance.now() - t0)}`);
  }
}
