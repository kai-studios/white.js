import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestClient } from '../src/test.js';
import { createMigrationEngine } from '../src/migrations/engine.js';
import { resolveConfig } from '../src/index.js';
import { tmpProject } from './helpers/project.js';

const example = fileURLToPath(new URL('../docs/examples/multi-generation-library', import.meta.url));

// A project with the two example packages installed
const project = () => {
  const p = tmpProject({
    'package.json': { name: 'site', type: 'module', dependencies: { 'white-meta-example': '*', 'white-auth-example': '*' } },
    'server/hooks.js': 'export const tags = meta.tags;\n',
  });
  for (const name of ['white-meta-example', 'white-auth-example']) {
    fs.cpSync(path.join(example, name), path.join(p.root, 'node_modules', name), { recursive: true });
  }
  return p;
};

test('the example library follows the generation chosen in white.protocols.json', async () => {
  const p = project();
  const config = { plugins: ['white-auth-example'] };
  const before = await createTestClient(config, { root: p.root });
  assert.deepEqual((await before.get('/auth/whoami')).json, { generation: '2.0', field: 'tags' });
  assert.equal(before.ctx.protocols.report.status, 'WARNING', 'meta@2.0 is deprecated');
  await before.close();

  const engine = createMigrationEngine({ root: p.root, config: resolveConfig(config) });
  const plan = await engine.plan({ target: 'meta@3.0' });
  assert.deepEqual(plan.blockers, [], 'the declared integrity matches migrations.js');
  await engine.apply(plan);
  assert.equal(p.read('server/hooks.js'), 'export const tags = meta.labels;\n');

  const after = await createTestClient(config, { root: p.root });
  assert.deepEqual((await after.get('/auth/whoami')).json, { generation: '3.0', field: 'labels' });
  assert.equal(after.ctx.protocols.report.status, 'OK');
  await after.close();
  p.cleanup();
});
