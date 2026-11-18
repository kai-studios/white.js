import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveModule } from '../src/core/resolve.js';
import { loadPluginModule } from '../src/core/loader.js';
import { PluginResolutionError } from '../src/index.js';
import { tmpProject, installPackage } from './helpers/project.js';

const esm = 'export default (app, ctx) => { ctx.loaded = (ctx.loaded ?? []).concat(NAME); };\n';
const cjs = (n) => `module.exports = (app, ctx) => { ctx.loaded = (ctx.loaded ?? []).concat("${n}"); };\n`;
const run = async (spec, root) => {
  const ctx = {};
  await (await loadPluginModule(spec, root))({}, ctx);
  return ctx.loaded;
};

test('a CommonJS package (main, no exports) loads', async () => {
  const p = tmpProject({ 'package.json': { name: 'app' } });
  installPackage(p, 'plug-cjs', { main: 'index.js' }, { 'index.js': cjs('cjs') });
  assert.deepEqual(await run('plug-cjs', p.root), ['cjs']);
});

test('an ESM-only package (type: module, exports with import only) loads', async () => {
  const p = tmpProject({ 'package.json': { name: 'app' } });
  installPackage(p, 'plug-esm', { type: 'module', exports: { '.': { import: './index.js' } } }, { 'index.js': esm.replace('NAME', '"esm"') });
  assert.deepEqual(await run('plug-esm', p.root), ['esm']);
});

test('exports conditions: import wins for import, require is the fallback for CommonJS-only packages', async () => {
  const p = tmpProject({ 'package.json': { name: 'app' } });
  installPackage(p, 'dual', { exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } } }, { 'esm.mjs': esm.replace('NAME', '"dual-import"'), 'cjs.cjs': cjs('dual-require') });
  installPackage(p, 'cjs-only', { exports: { '.': { require: './main.cjs' } } }, { 'main.cjs': cjs('cjs-only') });
  assert.equal(resolveModule('dual', p.root).file.endsWith('esm.mjs'), true);
  assert.equal(resolveModule('dual', p.root, { mode: 'require' }).file.endsWith('cjs.cjs'), true);
  assert.deepEqual(await run('dual', p.root), ['dual-import']);
  assert.equal(resolveModule('cjs-only', p.root).mode, 'require');
  assert.deepEqual(await run('cjs-only', p.root), ['cjs-only']);
});

test('exports: sugar forms, subpaths and patterns', () => {
  const p = tmpProject({ 'package.json': { name: 'app' } });
  installPackage(p, 'sugar', { exports: './main.js' }, { 'main.js': cjs('x') });
  installPackage(p, 'sub', { exports: { '.': './main.js', './feature': './f.js', './lib/*': './lib/*.js', './private': null } }, { 'main.js': '', 'f.js': '', 'lib/a.js': '' });
  assert.ok(resolveModule('sugar', p.root).file.endsWith('main.js'));
  assert.ok(resolveModule('sub/feature', p.root).file.endsWith('f.js'));
  assert.ok(resolveModule('sub/lib/a', p.root).file.endsWith(path.join('lib', 'a.js')));
  assert.throws(() => resolveModule('sub/private', p.root), { code: 'PLUGIN_ENTRY_NOT_EXPORTED' });
  assert.throws(() => resolveModule('sub/missing', p.root), { code: 'PLUGIN_ENTRY_NOT_EXPORTED' });
});

test('scoped packages are found, and the project is searched before anything else', async () => {
  const p = tmpProject({ 'package.json': { name: 'app' } });
  installPackage(p, '@acme/white-x', { main: 'i.js' }, { 'i.js': cjs('scoped') });
  assert.deepEqual(await run('@acme/white-x', p.root), ['scoped']);
});

test('a package found in a parent node_modules is resolved from the project, not from White.js', async () => {
  const parent = tmpProject({});
  installPackage(parent, 'hoisted', { main: 'i.js' }, { 'i.js': cjs('hoisted') });
  parent.write('site/package.json', { name: 'site' });
  assert.deepEqual(await run('hoisted', path.join(parent.root, 'site')), ['hoisted']);
});

test('relative and absolute paths, with or without extension, and folders', async () => {
  const p = tmpProject({ 'plugins/a.js': esm.replace('NAME', '"a"'), 'plugins/dir/index.js': esm.replace('NAME', '"dir"') });
  assert.deepEqual(await run('./plugins/a', p.root), ['a']);
  assert.deepEqual(await run('./plugins/a.js', p.root), ['a']);
  assert.deepEqual(await run(path.join(p.root, 'plugins/a.js'), p.root), ['a']);
  assert.deepEqual(await run('./plugins/dir', p.root), ['dir']);
});

test('a missing package or file explains what to do', () => {
  const p = tmpProject({ 'package.json': { name: 'app' } });
  assert.throws(() => resolveModule('not-installed', p.root), (e) => e instanceof PluginResolutionError && e.code === 'PLUGIN_NOT_FOUND' && /npm install not-installed/.test(e.hint));
  assert.throws(() => resolveModule('./nope.js', p.root), { code: 'PLUGIN_NOT_FOUND' });
});

test('a module without a default function is rejected; a throwing module reports where', async () => {
  const p = tmpProject({ 'bad.js': 'export const x = 1;', 'throws.js': 'throw new Error("boom");' });
  await assert.rejects(loadPluginModule('./bad.js', p.root), { code: 'PLUGIN_INVALID' });
  await assert.rejects(loadPluginModule('./throws.js', p.root), (e) => e.code === 'PLUGIN_LOAD_FAILED' && /boom/.test(e.message));
});

test('a CommonJS module compiled from ESM (exports.default) works', async () => {
  const p = tmpProject({ 'transpiled.cjs': 'Object.defineProperty(exports,"__esModule",{value:true}); exports.default = (a, ctx) => { ctx.loaded = ["interop"]; };' });
  assert.deepEqual(await run('./transpiled.cjs', p.root), ['interop']);
});
