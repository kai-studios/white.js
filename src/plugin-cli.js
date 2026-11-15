import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadPluginModule } from './loader.js';
import { addPlugin, removePlugin } from './config-edit.js';

// Package specs are passed to a shell on Windows, so only plain characters are allowed
const SAFE_SPEC = /^[@\w.\/:~+\\-]+$/;

const root = process.cwd();
const pkgFile = path.join(root, 'package.json');
const configFile = path.join(root, 'white.config.js');

function fail(message) {
  console.error(`White.js: ${message}`);
  process.exit(1);
}

const npm = (args) =>
  spawnSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;

const readDeps = () => ({ ...JSON.parse(fs.readFileSync(pkgFile, 'utf8')).dependencies });

// "auth" -> "white-plugin-auth"; scoped names, paths and full names are kept as given
const expand = (raw) => (/^[a-z0-9][a-z0-9-]*$/.test(raw) && !raw.startsWith('white-plugin-') ? `white-plugin-${raw}` : raw);

// "pkg@1.2.3" -> "pkg", "@scope/pkg@1" -> "@scope/pkg"
const nameOf = (spec) => (spec.startsWith('@') ? '@' + spec.slice(1).split('@')[0] : spec.split('@')[0]);

// For `file:` specs the package name is in the package.json of that folder
function nameOfLocal(spec) {
  if (!spec.startsWith('file:')) return null;
  try {
    const dir = path.resolve(root, spec.slice(5));
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name ?? null;
  } catch {
    return null;
  }
}

function updateConfig(edit, name) {
  const source = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
  const result = edit(source, name);
  if (result.manual) {
    console.log(`Could not edit white.config.js automatically. Add this entry to "plugins" yourself: '${name}'`);
  } else if (result.changed) {
    fs.writeFileSync(configFile, result.source);
    console.log(`white.config.js updated.`);
  } else {
    console.log(`white.config.js needs no changes.`);
  }
}

async function add(raw) {
  const spec = expand(raw);
  if (!SAFE_SPEC.test(spec)) fail(`Invalid plugin name: ${raw}`);

  const before = readDeps();
  console.log(`Installing ${spec} ...`);
  if (!npm(['install', spec])) fail(`npm could not install ${spec}`);

  const after = readDeps();
  // npm reports no name, so find it: the dependency that changed, else the spec itself
  const name = Object.keys(after).find((key) => before[key] !== after[key]) ?? nameOfLocal(spec) ?? nameOf(spec);

  try {
    await loadPluginModule(name, root);
  } catch (err) {
    // roll back, but only a package this command just installed
    if (name in after && !(name in before)) npm(['uninstall', name]);
    fail(`${name} is not a valid White.js plugin (${err.message}). It was not added.`);
  }

  updateConfig(addPlugin, name);
  console.log(`Plugin ${name} is ready. Plugins run with full access to your app: install only code you trust.`);
}

function remove(raw) {
  const spec = expand(raw);
  if (!SAFE_SPEC.test(spec)) fail(`Invalid plugin name: ${raw}`);
  const name = nameOf(spec);

  console.log(`Removing ${name} ...`);
  if (name in readDeps() && !npm(['uninstall', name])) fail(`npm could not remove ${name}`);
  updateConfig(removePlugin, name);
}

export async function pluginCommand([action, ...names]) {
  if (!['add', 'remove'].includes(action) || !names.length) {
    console.log('Usage:\n  white plugin add <name...>\n  white plugin remove <name...>');
    process.exit(1);
  }
  if (!fs.existsSync(pkgFile)) fail('No package.json here. Run this command from your project root.');
  for (const name of names) {
    if (action === 'add') await add(name);
    else remove(name);
  }
}
