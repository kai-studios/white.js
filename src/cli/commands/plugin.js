import fs from 'node:fs';
import path from 'node:path';
import * as ui from '../../ui/index.js';
import { exec } from '../proc.js';
import { loadPluginModule } from '../../core/loader.js';
import { addPlugin, removePlugin } from '../config-edit.js';

// Package specs end up in a shell command on Windows, so only plain characters are allowed
const SAFE_SPEC = /^[@\w.\/:~+\\-]+$/;
const USAGE = 'Usage:\n  white plugin add <name...>\n  white plugin remove <name...>';

const root = process.cwd();
const pkgFile = path.join(root, 'package.json');
const configFile = path.join(root, 'white.config.js');

function fail(message) {
  console.error(`\n  ${ui.t.error(ui.sym.err)}  ${message}\n`);
  process.exit(1);
}

const npm = (args, onLine) => exec('npm', args, { cwd: root, onLine });

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

// Returns a message describing what happened to white.config.js
function updateConfig(edit, name) {
  const source = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
  const result = edit(source, name);
  if (result.manual) {
    return { warn: `Could not edit white.config.js automatically. Add this entry to "plugins" yourself: '${name}'` };
  }
  if (result.changed) {
    fs.writeFileSync(configFile, result.source);
    return { info: 'white.config.js updated.' };
  }
  return { info: 'white.config.js needs no changes.' };
}

function report(outcome) {
  if (outcome.warn) ui.log.warn(outcome.warn);
  else ui.log.info(outcome.info);
}

async function add(raw) {
  const spec = expand(raw);
  if (!SAFE_SPEC.test(spec)) fail(`Invalid plugin name: ${raw}`);

  const before = readDeps();
  let name = nameOf(spec);
  let after = before;
  let outcome;

  await ui
    .tasks(`Adding ${ui.t.accent(spec)}`, [
      {
        title: 'Installing package',
        run: async ({ message }) => {
          await npm(['install', spec], message);
          after = readDeps();
          // npm reports no name, so find it: the dependency that changed, else the spec itself
          name = Object.keys(after).find((key) => before[key] !== after[key]) ?? nameOfLocal(spec) ?? name;
        },
      },
      {
        title: 'Checking the plugin',
        run: async () => {
          try {
            await loadPluginModule(name, root);
          } catch (err) {
            // roll back, but only a package this command just installed
            if (name in after && !(name in before)) await npm(['uninstall', name]).catch(() => {});
            throw new Error(`${name} is not a valid White.js plugin (${err.message}). It was not added.`);
          }
        },
      },
      { title: 'Updating white.config.js', run: () => (outcome = updateConfig(addPlugin, name)) },
    ])
    .catch((error) => fail(error.message, error.output));

  report(outcome);
  ui.log.success(`Plugin ${ui.t.accent(name)} is ready. Plugins run with full access to your app: install only code you trust.`);
}

async function remove(raw) {
  const spec = expand(raw);
  if (!SAFE_SPEC.test(spec)) fail(`Invalid plugin name: ${raw}`);
  const name = nameOf(spec);
  let outcome;

  await ui
    .tasks(`Removing ${ui.t.accent(name)}`, [
      {
        title: 'Uninstalling package',
        skip: !(name in readDeps()),
        run: ({ message }) => npm(['uninstall', name], message),
      },
      { title: 'Updating white.config.js', run: () => (outcome = updateConfig(removePlugin, name)) },
    ])
    .catch((error) => fail(`npm could not remove ${name}: ${error.message}`));

  report(outcome);
}

export async function pluginCommand([action, ...names]) {
  if (!['add', 'remove'].includes(action) || !names.length) {
    console.log(USAGE);
    process.exit(1);
  }
  if (!fs.existsSync(pkgFile)) fail('No package.json here. Run this command from your project root.');
  for (const name of names) {
    if (action === 'add') await add(name);
    else await remove(name);
  }
}
