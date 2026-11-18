import path from 'node:path';
import express from 'express';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { scanRoutes, trackMounts, collectRoutes } from './routes.js';
import { resolveModule, pickPluginFunction } from './resolve.js';
import { RouteLoadError, PluginResolutionError } from './white-error.js';

const imp = (file) => import(pathToFileURL(file).href);

export async function loadRoutes(app, ctx) {
  const base = ctx.abs(ctx.config.dirs.routes);
  const { routes, problems } = await scanRoutes(base, ctx.root);
  if (problems.length) {
    throw new RouteLoadError(`Invalid route files:\n  - ${problems.map((p) => p.message).join('\n  - ')}`, {
      code: problems[0].code,
      details: problems,
      hint: 'Run "white doctor" for the full list of route problems.',
    });
  }

  for (const route of routes) {
    const mod = await imp(route.file);
    if (typeof mod.default !== 'function') {
      ctx.log.warn(`[routes] ${route.rel}: no default export function(router, ctx), skipped`);
      continue;
    }
    const router = express.Router({ mergeParams: true });
    const mounts = trackMounts(router);
    await mod.default(router, ctx);
    app.use(route.url, router);

    // Remember every method + path (nested routers included) so the startup banner can list them
    for (const r of collectRoutes(router, mounts)) {
      ctx.routes.push({
        method: r.method,
        path: (route.url === '/' ? '' : route.url) + (r.path === '/' ? '' : r.path) || '/',
        file: route.rel,
        ...(r.approximate && { approximate: true }),
        ...(r.pattern && { pattern: true }),
      });
    }
  }
}

// Resolves a plugin the same way for `white plugin add`, startup and `white doctor`:
// returns the resolution without running any plugin code
export const resolvePlugin = (spec, root) => resolveModule(spec, root);

// Imports an already resolved plugin. A plugin is a module whose default export is
// function(app, ctx, options). Returns { plugin, module }.
async function loadResolved(resolution, spec, root) {
  let mod;
  try {
    mod = resolution.mode === 'require' ? createRequire(resolution.file)(resolution.file) : await imp(resolution.file);
  } catch (err) {
    throw new PluginResolutionError(`Plugin "${spec}" (${path.relative(root, resolution.file) || resolution.file}) failed to load: ${err.message}`, {
      code: 'PLUGIN_LOAD_FAILED',
      cause: err,
    });
  }
  const plugin = pickPluginFunction({ default: mod }) ?? pickPluginFunction(mod);
  if (!plugin) throw new PluginResolutionError(`"${spec}" must export a default function(app, ctx, options)`, { code: 'PLUGIN_INVALID' });
  return { plugin, module: mod };
}

// Loads a plugin by npm package name or by relative/absolute path; returns the function
export async function loadPluginModule(spec, root) {
  return (await loadResolved(resolvePlugin(spec, root), spec, root)).plugin;
}

// config.plugins items: 'name' | './path.js' | fn | ['name', options]
export async function loadPlugins(app, ctx) {
  for (const item of ctx.config.plugins ?? []) {
    const [target, options] = Array.isArray(item) ? item : [item];
    if (typeof target === 'function') {
      await target(app, ctx, options);
      continue;
    }
    const resolution = resolvePlugin(target, ctx.root);
    // An npm package is checked against the protocol registry BEFORE its code is imported
    if (resolution.kind === 'package') ctx.protocols?.assertPlugin(resolution.packageJson, target);
    const { plugin, module } = await loadResolved(resolution, target, ctx.root);
    // A local file may declare `export const white = { protocols: ... }`; it can only be read after import
    if (resolution.kind === 'path' && module.white) ctx.protocols?.assertPlugin({ name: target, white: module.white }, target);
    await plugin(app, ctx, options);
  }
}
