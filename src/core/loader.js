import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const imp = (file) => import(pathToFileURL(file).href);

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory does not exist: skip it
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith('.js')) yield full;
  }
}

// server/routes/api/users.js        -> /api/users
// server/routes/client/index.js     -> /
// server/routes/client/blog/[id].js -> /blog/:id
// "client" routes get no prefix, "api" routes get /api
function toUrl(rel) {
  const parts = rel.replace(/\\/g, '/').replace(/\.js$/, '').split('/');
  const group = parts.shift(); // api | client
  if (parts.at(-1) === 'index') parts.pop();
  const url = '/' + parts.map((p) => p.replace(/^\[(.+)\]$/, ':$1')).join('/');
  return group === 'api' ? '/api' + (url === '/' ? '' : url) : url;
}

export async function loadRoutes(app, ctx) {
  const base = ctx.abs(ctx.config.dirs.routes);
  for await (const file of walk(base)) {
    const mod = await imp(file);
    if (typeof mod.default !== 'function') {
      ctx.log.warn(`[routes] ${file}: no default export function(router, ctx), skipped`);
      continue;
    }
    const router = express.Router({ mergeParams: true });
    await mod.default(router, ctx);
    const url = toUrl(path.relative(base, file));
    app.use(url, router);

    // Remember every method + path so the startup banner can list them
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const sub = layer.route.path === '/' ? '' : layer.route.path;
      for (const method of Object.keys(layer.route.methods)) {
        ctx.routes.push({ method: method.toUpperCase(), path: (url === '/' ? '' : url) + sub || '/' });
      }
    }
  }
}

// Loads a plugin by npm package name or by relative/absolute path.
// A plugin is a module whose default export is function(app, ctx, options).
export async function loadPluginModule(spec, root) {
  let mod;
  if (spec.startsWith('.') || path.isAbsolute(spec)) {
    mod = await imp(path.resolve(root, spec));
  } else {
    let url;
    try {
      // resolve from the project first, so the plugin is found next to the site's own packages
      url = pathToFileURL(createRequire(path.join(root, 'package.json')).resolve(spec)).href;
    } catch {
      // ESM-only packages: fall back to a plain import
    }
    mod = await import(url ?? spec);
  }
  if (typeof mod.default !== 'function') {
    throw new Error(`"${spec}" must export a default function(app, ctx, options)`);
  }
  return mod.default;
}

// config.plugins items: 'name' | './path.js' | fn | ['name', options]
export async function loadPlugins(app, ctx) {
  for (const item of ctx.config.plugins ?? []) {
    const [target, options] = Array.isArray(item) ? item : [item];
    const plugin = typeof target === 'function' ? target : await loadPluginModule(target, ctx.root);
    await plugin(app, ctx, options);
  }
}
