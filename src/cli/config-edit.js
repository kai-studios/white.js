// Text-level edits of white.config.js for `white plugin add/remove`.
// Only simple arrays of strings are rewritten; anything else is reported as
// "manual" so a hand-written config is never damaged.

const STRING_RE = /(['"`])((?:(?!\1).)*)\1/g;

// True if the match sits after a // comment marker on its line
const inComment = (source, index) => {
  const prefix = source.slice(source.lastIndexOf('\n', index - 1) + 1, index);
  return prefix.includes('//') || prefix.includes('/*');
};

// Finds `plugins: [ ... ]` in real code (not in comments).
// Returns { index, length, indent, inner } or null.
function findPlugins(source) {
  for (const m of source.matchAll(/\bplugins\s*:\s*\[([\s\S]*?)\]/g)) {
    if (inComment(source, m.index)) continue;
    const lineStart = source.lastIndexOf('\n', m.index - 1) + 1;
    const indent = /^[ \t]*/.exec(source.slice(lineStart))[0];
    return { index: m.index, length: m[0].length, indent, inner: m[1] };
  }
  return null;
}

// True if `plugins` appears in real code in some form we cannot edit (e.g. a variable)
const hasOtherPlugins = (source) =>
  [...source.matchAll(/\bplugins\b/g)].some((m) => !inComment(source, m.index));

const quote = (name) => `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// Returns the plugin names if the array is a plain list of strings, otherwise null
function parseList(inner) {
  if (/\/\/|\/\*/.test(inner)) return null; // comments inside: do not rewrite
  const names = [...inner.matchAll(STRING_RE)].map((m) => m[2]);
  const leftover = inner.replace(STRING_RE, '').replace(/[\s,]/g, '');
  return leftover === '' ? names : null;
}

function render(names, indent, itemIndent, multiline) {
  if (!names.length) return '[]';
  if (!multiline) return `[${names.map(quote).join(', ')}]`;
  return `[\n${names.map((n) => `${itemIndent}${quote(n)},`).join('\n')}\n${indent}]`;
}

function rewrite(source, found, names) {
  const multiline = found.inner.includes('\n') || names.length > 2;
  // keep the file's own indentation of list items when there is one
  const itemIndent = /\n([ \t]+)\S/.exec(found.inner)?.[1] ?? found.indent + '  ';
  const replaced = `plugins: ${render(names, found.indent, itemIndent, multiline)}`;
  return source.slice(0, found.index) + replaced + source.slice(found.index + found.length);
}

export function addPlugin(source, name) {
  if (source == null) {
    return { source: `export default {\n  plugins: [${quote(name)}],\n};\n`, changed: true };
  }

  const found = findPlugins(source);
  if (found) {
    const names = parseList(found.inner);
    if (!names) return { source, manual: true };
    if (names.includes(name)) return { source, changed: false };
    return { source: rewrite(source, found, [...names, name]), changed: true };
  }
  if (hasOtherPlugins(source)) return { source, manual: true };

  // No plugins key yet: insert it at the top of `export default { ... }`
  const head = /export\s+default\s*\{/.exec(source);
  if (!head) return { source, manual: true };
  const at = head.index + head[0].length;
  const rest = source.slice(at);
  const line = `  plugins: [${quote(name)}],`;
  const next = rest.trimStart().startsWith('}')
    ? source.slice(0, at) + `\n${line}\n` + rest.trimStart()
    : source.slice(0, at) + `\n${line}` + rest;
  return { source: next, changed: true };
}

export function removePlugin(source, name) {
  if (source == null) return { source, changed: false };
  const found = findPlugins(source);
  if (!found) return hasOtherPlugins(source) ? { source, manual: true } : { source, changed: false };
  const names = parseList(found.inner);
  if (!names) return { source, manual: true };
  if (!names.includes(name)) return { source, changed: false };
  return { source: rewrite(source, found, names.filter((n) => n !== name)), changed: true };
}
