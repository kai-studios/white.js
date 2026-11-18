import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadConfig, resolveConfig } from '../core/config.js';
import { ConfigError, WhiteError } from '../core/white-error.js';
import { scanRoutes, shadowedPairs } from '../core/routes.js';
import { resolveModule } from '../core/resolve.js';
import { loadProtocolState } from '../protocols/index.js';
import { incompleteRuns, readLedger } from '../migrations/store.js';

// `white doctor`: a read-only diagnosis of a project.
//
// By default NOTHING of the project's own code is run: no plugin, no route, no migration. The
// checks read files (package.json, route folders, installed libraries) and resolve module names.
// Config is the one exception, because white.config.js is the configuration itself. Only with
// deep: true is the app built, as `white run` would do, which does run plugins and routes.
//
// Severities: ok | info | warning | error | critical (a security problem)
//   exit code 0  nothing worse than warnings      1  errors      2  critical security problems

const MIN_NODE = [20, 12];
const item = (severity, title, detail, extra) => ({ severity, title, ...(detail && { detail }), ...extra });

function portFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, ...(host ? [host] : []), () => server.close(() => resolve(true)));
  });
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

function environment(root, pkg) {
  const out = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  out.push(major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]) ? item('ok', `Node.js ${process.versions.node}`) : item('error', `Node.js ${process.versions.node}`, `White.js needs ${MIN_NODE.join('.')} or newer`));
  if (!pkg) return [...out, item('error', 'package.json', 'not found or not valid JSON. Run this command from the project root')];
  const installed = { ...pkg.dependencies, ...pkg.devDependencies };
  out.push('white-js' in installed ? item('ok', 'white-js is a dependency') : item('warning', 'white-js is not in package.json', 'npm install white-js'));
  out.push(/white run/.test(Object.values(pkg.scripts ?? {}).join(' ')) ? item('ok', 'start scripts use "white run"') : item('warning', 'no script runs "white run"', 'add "start": "white run" and "dev": "white run dev"'));
  if (pkg.type !== 'module') out.push(item('error', 'package.json needs "type": "module"', 'routes and plugins are ES modules'));
  return out;
}

function coreConfig(config) {
  const out = [];
  const { trustProxy, requestId, shutdownTimeout } = config;
  out.push(trustProxy === false ? item('info', 'trustProxy is off', 'the client address is the socket address. Behind a reverse proxy set trustProxy to the number of proxies (1) or to their addresses') : item('ok', 'trustProxy is set'));
  if (requestId.accept === 'always') out.push(item('warning', 'requestId.accept is "always"', 'any client can choose the id that appears in your logs. Use "trusted" together with trustProxy'));
  else out.push(item('ok', `request ids: ${requestId.accept === 'never' ? 'always generated' : 'accepted from trusted proxies'}`));
  out.push(shutdownTimeout < 1000 ? item('warning', `shutdownTimeout is ${shutdownTimeout} ms`, 'requests and onClose handlers may be cut off') : item('ok', `shutdownTimeout ${shutdownTimeout} ms`));
  return out;
}

async function loader(root, config, pkg, scan) {
  const out = [];
  for (const [key, label] of [['routes', 'routes'], ['views', 'views'], ['public', 'static files']]) {
    const dir = path.join(root, config.dirs[key]);
    out.push(fs.existsSync(dir) ? item('ok', `${label}: ${config.dirs[key]}`) : item(key === 'routes' ? 'warning' : 'warning', `${label}: ${config.dirs[key]} does not exist`));
  }
  if (fs.existsSync(path.join(root, config.dirs.views)) && !fs.existsSync(path.join(root, config.dirs.views, 'error.eta'))) out.push(item('info', 'no error.eta view', 'a built-in error page is used'));

  // routes: layout, groups, parameter names, conflicts. Route files are not imported.
  let routes = [];
  try {
    const result = await scanRoutes(path.join(root, config.dirs.routes), root);
    routes = result.routes;
    for (const p of result.problems) out.push(item('error', p.code === 'ROUTE_CONFLICT' ? 'route conflict' : p.code === 'ROUTE_UNKNOWN_GROUP' ? 'unknown route group' : 'invalid route file', p.message));
    if (!result.problems.length) out.push(item('ok', `${routes.length} route file${routes.length === 1 ? '' : 's'}, layout is valid`));
    for (const { static: s, dynamic: d } of shadowedPairs(routes)) out.push(item('info', `${s.url} and ${d.url} can match the same URL`, `${s.rel} is mounted first, so it wins; ${d.rel} handles the rest`));
  } catch (error) {
    out.push(item('error', 'the routes folder cannot be read', error.message));
  }

  // plugins: declarations and resolution
  const declared = { ...pkg?.dependencies, ...pkg?.optionalDependencies, ...pkg?.devDependencies };
  for (const entry of config.plugins ?? []) {
    const target = Array.isArray(entry) ? entry[0] : entry;
    if (typeof target === 'function') {
      out.push(item('ok', `plugin: function ${target.name || '(anonymous)'}`));
      continue;
    }
    if (typeof target !== 'string' || !target || (Array.isArray(entry) && entry.length > 2)) {
      out.push(item('error', 'invalid plugin declaration', `${JSON.stringify(entry)}: use 'name', './file.js', a function, or ['name', options]`));
      continue;
    }
    try {
      const r = resolveModule(target, root);
      const where = r.kind === 'package' ? `${r.name}@${r.packageJson.version ?? '?'}` : path.relative(root, r.file);
      out.push(item('ok', `plugin: ${target}`, `${where}${r.mode === 'require' ? ' (CommonJS entry)' : ''}`));
      if (r.kind === 'package' && !(r.name in declared)) out.push(item('warning', `${r.name} is not in package.json`, `it was found in node_modules, but nothing declares it. Run: npm install ${r.name}`));
    } catch (error) {
      out.push(item('error', `plugin: ${target}`, error.message + (error.hint ? ` (${error.hint})` : '')));
    }
  }
  if (scan.missing.length) out.push(item('warning', `${scan.missing.length} dependenc${scan.missing.length === 1 ? 'y is' : 'ies are'} not installed`, `${scan.missing.slice(0, 5).join(', ')}${scan.missing.length > 5 ? ', …' : ''}. Run: npm install`));
  return out;
}

async function meshChecks(config) {
  if (!config.mesh) return [];
  try {
    const { normalizeMesh, meshWarnings } = await import('../mesh/config.js');
    const mesh = normalizeMesh(config.mesh);
    const count = Object.keys(mesh.peers).length;
    return [item('ok', `mesh: service "${mesh.name}", ${count} peer${count === 1 ? '' : 's'}`), ...meshWarnings(mesh).map((w) => item('warning', 'mesh', w))];
  } catch (error) {
    return [item('error', 'mesh configuration', error.message)];
  }
}

// Protocol findings, as doctor items
function protocolItems(state) {
  const { report, scan } = state;
  const out = state.report.findings.map((f) =>
    item(f.severity, f.message.split('\n')[0], f.hint, { code: f.code, protocol: f.protocol, subject: f.subject, security: f.severity === 'critical' }),
  );
  if (!out.length) out.push(item('ok', report.users.length ? 'all protocol versions in use are supported' : 'no library declares protocol requirements'));
  void scan;
  return out;
}

async function migrationState(root) {
  const out = [];
  try {
    const runs = await incompleteRuns(root);
    if (runs.length) out.push(item('error', 'an earlier migration was interrupted', `${runs.map((r) => r.runId).join(', ')}. Run: white migrate --recover`));
    const ledger = await readLedger(root);
    if (ledger.applied.length) out.push(item('info', `${ledger.applied.length} migration${ledger.applied.length === 1 ? '' : 's'} applied`, ledger.applied.map((a) => a.id).join(', ')));
  } catch (error) {
    out.push(item('error', 'migration ledger', error.message));
  }
  return out;
}

async function deepChecks(root, config) {
  const out = [item('info', 'deep check: plugins and routes are being loaded', 'their code runs, including any side effects at import time')];
  process.env.LOG_LEVEL ??= 'silent';
  const { createApp } = await import('../core/app.js');
  let app;
  try {
    app = await createApp(config, root);
    const seen = new Map();
    const duplicates = [];
    for (const r of app.ctx.routes) {
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) duplicates.push(`${key} in ${seen.get(key)} and ${r.file}`);
      else seen.set(key, r.file);
    }
    out.push(item('ok', `${app.ctx.routes.length} route${app.ctx.routes.length === 1 ? '' : 's'} loaded`));
    if (duplicates.length) out.push(item('warning', 'duplicate routes', duplicates.join('; ')));
    const approx = app.ctx.routes.filter((r) => r.approximate);
    if (approx.length) out.push(item('info', `${approx.length} route path${approx.length === 1 ? ' is' : 's are'} approximate`, 'a nested router was mounted in a way that could not be observed; see docs/routing.md'));
  } catch (error) {
    out.push(item('error', 'routes or plugins fail to load', error.message));
  } finally {
    await app?.stop(); // release what the plugins opened
  }
  return out;
}

export async function diagnose(root = process.cwd(), { deep = false } = {}) {
  const sections = [];
  const add = (title, items) => items.length && sections.push({ title, items });

  const pkgFile = path.join(root, 'package.json');
  const pkg = fs.existsSync(pkgFile) ? readJson(pkgFile) : null;
  add('Environment', environment(root, pkg));
  if (!pkg) return finish(sections);

  let config;
  try {
    config = await loadConfig(root);
    add('Core', [item('ok', 'white.config.js loads'), ...coreConfig(config)]);
  } catch (error) {
    add('Core', [item('error', error instanceof WhiteError ? 'configuration' : 'white.config.js', error.message + (error.hint ? ` (${error.hint})` : ''))]);
    config = resolveConfig({}); // keep going with the defaults
  }

  const state = loadProtocolState(config, root);
  add('Loader', await loader(root, config, pkg, state.scan));
  add('Services', await meshChecks(config));
  add('Protocol Compatibility', protocolItems(state));
  add('Migrations', await migrationState(root));
  if (deep) add('Deep check', await deepChecks(root, config));
  add('Network', [(await portFree(config.port, config.host)) ? item('ok', `port ${config.port} is free`) : item('warning', `port ${config.port} is in use`, 'set PORT to use another one')]);
  return finish(sections, state);
}

function finish(sections, state) {
  const all = sections.flatMap((s) => s.items);
  const count = (sev) => all.filter((i) => i.severity === sev).length;
  const summary = { info: count('info'), warning: count('warning'), error: count('error'), critical: count('critical') };
  const status = summary.critical ? 'CRITICAL' : summary.error ? 'ERROR' : summary.warning ? 'WARNING' : 'OK';
  return { sections, summary, status, exitCode: summary.critical ? 2 : summary.error ? 1 : 0, protocols: state?.report, registry: state?.registry };
}

// The flat list the earlier version returned, for callers that used it
export async function runChecks(root = process.cwd(), options) {
  const { sections } = await diagnose(root, options);
  const level = { ok: 'ok', info: 'ok', warning: 'warn', error: 'fail', critical: 'fail' };
  return sections.flatMap((s) => s.items).map((i) => ({ level: level[i.severity], title: i.title, detail: i.detail }));
}
