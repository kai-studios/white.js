import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import * as ui from '../../ui/index.js';

const MIN_NODE = [20, 12];

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

const ok = (title, detail) => ({ level: 'ok', title, detail });
const warn = (title, detail) => ({ level: 'warn', title, detail });
const fail = (title, detail) => ({ level: 'fail', title, detail });

// Looks at a project and returns what is fine, what is suspicious and what is broken.
export async function runChecks(root = process.cwd()) {
  const results = [];

  const [major, minor] = process.versions.node.split('.').map(Number);
  results.push(
    major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
      ? ok(`Node.js ${process.versions.node}`)
      : fail(`Node.js ${process.versions.node}`, `White.js needs ${MIN_NODE.join('.')} or newer`),
  );

  // package.json
  const pkgFile = path.join(root, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    results.push(fail('package.json', 'not found. Run this command from the project root'));
    return results;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const installed = { ...pkg.dependencies, ...pkg.devDependencies };
  results.push('white-js' in installed ? ok('white-js is a dependency') : warn('white-js is not in package.json', 'npm install white-js'));
  const scripts = Object.values(pkg.scripts ?? {}).join(' ');
  results.push(/white run/.test(scripts) ? ok('start scripts use "white run"') : warn('no script runs "white run"', 'add "start": "white run" and "dev": "white run dev"'));
  if (pkg.type !== 'module') results.push(fail('package.json needs "type": "module"', 'routes and plugins are ES modules'));

  // config
  const { loadConfig, ConfigError } = await import('../../index.js');
  let config;
  try {
    config = await loadConfig(root);
    results.push(ok('white.config.js loads'));
  } catch (error) {
    results.push(fail(error instanceof ConfigError ? 'environment' : 'white.config.js', error.message));
    return results;
  }

  // folders
  for (const [key, label] of [['routes', 'routes'], ['views', 'views'], ['public', 'static files']]) {
    const dir = path.join(root, config.dirs[key]);
    results.push(fs.existsSync(dir) ? ok(`${label}: ${config.dirs[key]}`) : (key === 'routes' ? fail : warn)(`${label}: ${config.dirs[key]} does not exist`));
  }
  if (fs.existsSync(path.join(root, config.dirs.views)) && !fs.existsSync(path.join(root, config.dirs.views, 'error.eta'))) {
    results.push(warn('no error.eta view', 'a built-in error page is used'));
  }

  // routes load and do not clash
  try {
    process.env.LOG_LEVEL ??= 'silent';
    const { createApp } = await import('../../index.js');
    const { ctx } = await createApp(config, root);
    const seen = new Map();
    const duplicates = [];
    for (const r of ctx.routes) {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) duplicates.push(`${key} in ${seen.get(key)} and ${r.file}`);
      else seen.set(key, r.file);
    }
    results.push(ok(`${ctx.routes.length} route${ctx.routes.length === 1 ? '' : 's'} loaded`));
    if (duplicates.length) results.push(warn('duplicate routes', duplicates.join('; ')));
  } catch (error) {
    results.push(fail('routes or plugins fail to load', error.message));
  }

  // services
  if (config.mesh) {
    try {
      const { normalizeMesh, meshWarnings } = await import('../../mesh/config.js');
      const mesh = normalizeMesh(config.mesh);
      const count = Object.keys(mesh.peers).length;
      results.push(ok(`mesh: service "${mesh.name}", ${count} peer${count === 1 ? '' : 's'}`));
      for (const w of meshWarnings(mesh)) results.push(warn('mesh', w));
    } catch (error) {
      results.push(fail('mesh configuration', error.message));
    }
  }

  results.push((await portFree(config.port)) ? ok(`port ${config.port} is free`) : warn(`port ${config.port} is in use`, 'set PORT to use another one'));
  return results;
}

export async function doctorCommand(root = process.cwd()) {
  const results = await runChecks(root);
  const icon = { ok: ui.t.success(ui.sym.ok), warn: ui.t.warn(ui.sym.fail), fail: ui.t.error(ui.sym.err) };
  console.log('');
  for (const r of results) {
    console.log(`  ${icon[r.level]}  ${r.title}${r.detail ? ui.t.muted(`  ${r.detail}`) : ''}`);
  }
  const failed = results.filter((r) => r.level === 'fail').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  console.log(`\n  ${failed ? ui.t.error(`${failed} problem${failed === 1 ? '' : 's'}`) : ui.t.success('All good')}${warned ? ui.t.muted(`, ${warned} warning${warned === 1 ? '' : 's'}`) : ''}\n`);
  process.exit(failed ? 1 : 0);
}
