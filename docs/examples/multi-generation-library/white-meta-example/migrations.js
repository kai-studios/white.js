// Migration meta@2.0 -> meta@3.0 of the example "meta" protocol.
// (A plain object works as well as defineMigration() from 'white-js'; the engine validates both.)
export default {
  id: 'meta-2.0-to-3.0',
  protocol: 'meta',
  from: '2.0',
  to: '3.0',
  title: 'meta.tags is now meta.labels',

  // Read-only: describe what has to change.
  async plan(project) {
    const operations = [];
    const manual = [];
    for (const file of await project.list('server', { ext: '.js' })) {
      const text = await project.read(file);
      if (text.includes('meta.tags')) {
        operations.push(project.edit(file, text.replaceAll('meta.tags', 'meta.labels'), 'meta.tags was renamed to meta.labels'));
      }
      // A removed API cannot be translated mechanically: ask the developer.
      if (text.includes('meta.legacyHook')) {
        manual.push({ file, message: 'meta.legacyHook was removed in meta@3.0', hint: 'Subscribe with meta.on("change", handler) instead.' });
      }
    }
    return { operations, manual }; // already migrated: both lists are empty
  },

  // Runs after the files are written; { ok: false } rolls everything back.
  async verify(project) {
    for (const file of await project.list('server', { ext: '.js' })) {
      if ((await project.read(file)).includes('meta.tags')) return { ok: false, problems: [`${file} still uses meta.tags`] };
    }
    return { ok: true };
  },
};
