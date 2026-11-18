import { MigrationError } from '../core/white-error.js';
import { tryParseRef } from '../protocols/version.js';

// What a protocol author writes. A migration module default-exports one migration or a list:
//
//   import { defineMigration } from 'white-js';
//
//   export default defineMigration({
//     id: 'meta-2.0-to-3.0',                 // unique; must match migration.id of meta@3.0
//     protocol: 'meta', from: '2.0', to: '3.0',
//     title: 'Rename meta.tags to meta.labels',
//
//     // Look at the project and say what has to change. READ-ONLY: it must not write anything.
//     async plan(project) {
//       const operations = [];
//       const manual = [];
//       for (const file of await project.list('server', { ext: '.js' })) {
//         const text = await project.read(file);
//         if (text.includes('meta.tags')) operations.push(project.edit(file, text.replaceAll('meta.tags', 'meta.labels'), 'meta.tags was renamed'));
//         if (text.includes('meta.legacyHook')) manual.push({ file, message: 'meta.legacyHook was removed', hint: 'Use meta.on("change") instead.' });
//       }
//       return { operations, manual };
//     },
//
//     // Optional: runs on the project AFTER the changes were written. { ok: false, problems: [...] } rolls everything back.
//     async verify(project) { return { ok: !(await project.read('server/meta.js')).includes('meta.tags') }; },
//   });
//
// Rules the engine enforces: plan() must be idempotent (when the project is already migrated it
// returns no operations); operations are only "edit" (existing file) or "create" (new file), never
// delete; package.json and lockfiles are off limits (migrations are not dependency updates);
// every path stays inside the project.
export function defineMigration(definition) {
  const problems = [];
  const d = definition ?? {};
  if (typeof d.id !== 'string' || !/^[a-z0-9][a-z0-9._/@-]{2,120}$/i.test(d.id)) problems.push('"id" must be a unique string of letters, digits and . _ / @ -');
  const from = tryParseRef(`${d.protocol}@${d.from}`);
  const to = tryParseRef(`${d.protocol}@${d.to}`);
  if (!from) problems.push('"protocol" and "from" must form a valid reference such as meta@2.0');
  if (!to) problems.push('"protocol" and "to" must form a valid reference such as meta@3.0');
  if (typeof d.plan !== 'function') problems.push('"plan(project)" must be a function');
  if (d.verify !== undefined && typeof d.verify !== 'function') problems.push('"verify(project)" must be a function');
  if (problems.length) throw new MigrationError(`Invalid migration${d?.id ? ` "${d.id}"` : ''}:\n  - ${problems.join('\n  - ')}`);
  return Object.freeze({ title: d.id, description: '', ...d });
}
