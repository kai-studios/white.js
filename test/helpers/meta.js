import { tmpProject, installPackage } from './project.js';
import { integrityOf } from '../../src/migrations/diff.js';

// The scenario of the specification, as a real project on disk:
//   white-meta   defines meta@2.0 (deprecated) and meta@3.0 (current), implements both,
//                and ships the migration 2.0 -> 3.0
//   white-auth   requires meta 2.0, supports 2.0 and 3.0
//   white-cache  requires meta 2.0, supports 2.0 only
//   white-mesh   requires meta 3.0
export const MIGRATION_SOURCE = `
export default {
  id: 'meta-2.0-to-3.0',
  protocol: 'meta', from: '2.0', to: '3.0',
  title: 'meta.tags became meta.labels',
  async plan(project) {
    const operations = [];
    const manual = [];
    for (const file of await project.list('server', { ext: '.js' })) {
      const text = await project.read(file);
      if (text.includes('meta.tags')) operations.push(project.edit(file, text.replaceAll('meta.tags', 'meta.labels'), 'meta.tags was renamed to meta.labels'));
      if (text.includes('meta.legacyHook')) manual.push({ file, message: 'meta.legacyHook was removed', hint: 'Use meta.on("change") instead.' });
    }
    return { operations, manual };
  },
  async verify(project) {
    for (const file of await project.list('server', { ext: '.js' })) {
      if ((await project.read(file)).includes('meta.tags')) return { ok: false, problems: [file + ' still uses meta.tags'] };
    }
    return { ok: true };
  },
};
`;

export const protocolManifests = (over = {}) => [
  {
    name: 'meta', version: '2.0', status: 'deprecated', compatibility: { white: '>=0.3.0' },
    deprecation: { since: '2026-06', message: 'use meta@3.0' },
  },
  {
    name: 'meta', version: '3.0', status: 'current', compatibility: { white: '>=0.3.0', protocols: [] },
    replaces: 'meta@2.0',
    migration: { from: 'meta@2.0', to: 'meta@3.0', strategy: 'automatic', id: 'meta-2.0-to-3.0', integrity: integrityOf(MIGRATION_SOURCE) },
    ...over,
  },
];

export function metaProject({ files = {}, config = '', manifests = protocolManifests(), migrationSource = MIGRATION_SOURCE, libs = {} } = {}) {
  const p = tmpProject({
    'package.json': { name: 'app', version: '1.0.0', type: 'module', dependencies: { 'white-meta': '*', 'white-auth': '*', 'white-cache': '*', 'white-mesh': '*' } },
    'server/hooks.js': 'export const tags = meta.tags;\n',
    ...files,
  });
  if (config) p.write('white.config.js', config);
  installPackage(p, 'white-meta', { version: '1.0.0', white: { provides: { meta: ['2.0', '3.0'] }, defines: manifests, migrations: './migrations.js' } }, { 'migrations.js': migrationSource });
  installPackage(p, 'white-auth', { version: '2.4.0', white: { protocols: { meta: { required: '2.0', supported: ['2.0', '3.0'] } } }, ...libs['white-auth'] });
  installPackage(p, 'white-cache', { version: '1.2.0', white: { protocols: { meta: { required: '2.0' } } }, ...libs['white-cache'] });
  installPackage(p, 'white-mesh', { version: '3.1.0', white: { protocols: { meta: { required: '3.0', supported: ['3.0'] } } }, ...libs['white-mesh'] });
  return p;
}
