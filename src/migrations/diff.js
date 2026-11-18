import crypto from 'node:crypto';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const integrityOf = (data) => `sha256-${crypto.createHash('sha256').update(data).digest('base64')}`;

// Line diff in the unified format (3 lines of context). Identical beginnings and endings are
// trimmed first; the middle uses the longest common subsequence, capped so a huge rewrite
// cannot take long (then the whole middle is shown as replaced).
const MAX_CELLS = 4_000_000;

function lcsOps(a, b) {
  if (a.length * b.length > MAX_CELLS) return [...a.map((t) => ['-', t]), ...b.map((t) => ['+', t])];
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push([' ', a[i++]]), j++;
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < a.length) ops.push(['-', a[i++]]);
  while (j < b.length) ops.push(['+', b[j++]]);
  return ops;
}

const lines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

export function diffStats(before, after) {
  const ops = diffOps(before ?? '', after);
  return { added: ops.filter((o) => o[0] === '+').length, removed: ops.filter((o) => o[0] === '-').length };
}

function diffOps(before, after) {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  return [
    ...a.slice(0, start).map((t) => [' ', t]),
    ...lcsOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((t) => [' ', t]),
  ];
}

// before === null means a new file
export function unifiedDiff(file, before, after, context = 3) {
  const ops = diffOps(before ?? '', after);
  const changed = ops.map((o, i) => (o[0] === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return '';
  const hunks = [];
  for (const i of changed) {
    const last = hunks.at(-1);
    if (last && i - last.end <= context * 2) last.end = i;
    else hunks.push({ start: i, end: i });
  }
  const out = [`--- ${before === null ? '/dev/null' : `a/${file}`}`, `+++ b/${file}`];
  for (const h of hunks) {
    const from = Math.max(0, h.start - context);
    const to = Math.min(ops.length - 1, h.end + context);
    const slice = ops.slice(from, to + 1);
    const oldStart = ops.slice(0, from).filter((o) => o[0] !== '+').length + 1;
    const newStart = ops.slice(0, from).filter((o) => o[0] !== '-').length + 1;
    const oldLen = slice.filter((o) => o[0] !== '+').length;
    const newLen = slice.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`, ...slice.map(([k, t]) => k + t));
  }
  return out.join('\n');
}
