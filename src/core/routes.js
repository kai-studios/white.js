import fs from 'node:fs/promises';
import path from 'node:path';
import { RouteLoadError } from './white-error.js';

// File-based routes: what a route folder means, decided in one place and without importing
// any route (so `white doctor` can use it).
//
//   <routes>/api/users.js          -> /api/users
//   <routes>/api/users/index.js    -> /api/users
//   <routes>/client/index.js       -> /
//   <routes>/client/blog/[id].js   -> /blog/:id
//
// Rules
//  - The first folder is the group: "api" (URLs get the /api prefix) or "client" (no prefix).
//    Any other folder or file at the top level is an error.
//  - A missing routes folder (or a missing group folder) is fine: there are simply no routes.
//  - A dynamic segment is written [name]; name must be a valid identifier (letters, digits, _; no leading digit).
//    The characters  : * ( ) { } [ ] ? + !  and backslash have a meaning in Express paths, so
//    outside the [name] form they are refused in file and folder names.
//  - Two files that give the same URL, or the same shape with different parameter names
//    (blog/[id].js and blog/[slug].js), are an error.
//  - Order of mounting (so priority) is deterministic: compared segment by segment, a static
//    segment comes before a dynamic one (/profile before /:id), equal segments are compared by
//    code point, and a shorter path comes before a longer one that starts the same way.

export const GROUPS = Object.freeze(['api', 'client']);
const PARAM = /^\[([^\]]*)\]$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SPECIAL = /[:*(){}[\]?+!\\]/;

async function readdir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null; // absent: no routes
    throw new RouteLoadError(`Cannot read the routes folder ${dir}: ${err.message}`, { code: err.code ?? 'ROUTE_FS_ERROR', cause: err });
  }
}

async function* walk(dir) {
  const entries = await readdir(dir);
  if (!entries) return;
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith('.js')) yield full;
  }
}

// Turns "blog/[id]" segments into descriptors; returns { segments, problem? }
export function parseSegments(raw) {
  const segments = [];
  for (const text of raw) {
    const m = PARAM.exec(text);
    if (m) {
      if (!PARAM_NAME.test(m[1])) return { problem: `"${text}" is not a valid parameter: use letters, digits and _ (for example [id]), not starting with a digit` };
      segments.push({ kind: 'param', name: m[1], text });
    } else if (SPECIAL.test(text)) {
      return { problem: `"${text}" contains characters that have a meaning in route paths. Parameters are written [name]` };
    } else {
      segments.push({ kind: 'static', name: text, text });
    }
  }
  return { segments };
}

export function compareRoutes(a, b) {
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const [x, y] = [a.segments[i], b.segments[i]];
    if (x.kind !== y.kind) return x.kind === 'static' ? -1 : 1;
    if (x.text !== y.text) return x.text < y.text ? -1 : 1;
  }
  return a.segments.length - b.segments.length;
}

const urlOf = (group, segments) => {
  const tail = segments.map((s) => (s.kind === 'param' ? `:${s.name}` : s.name)).join('/');
  return group === 'api' ? `/api${tail ? '/' + tail : ''}` : `/${tail}`;
};

// A string that is equal for URLs that would match the same requests
const shapeOf = (group, segments) => group + '/' + segments.map((s) => (s.kind === 'param' ? ':' : s.name)).join('/');

// Looks at the routes folder and returns { routes, problems }.
//   routes:   [{ file, rel, group, url, segments }] sorted by mounting order
//   problems: [{ code, message, file? }]  (an empty list means the layout is valid)
export async function scanRoutes(base, root = base) {
  const problems = [];
  const found = [];
  const top = await readdir(base);
  if (!top) return { routes: [], problems };

  for (const entry of top) {
    if (!GROUPS.includes(entry.name) || !entry.isDirectory()) {
      problems.push({
        code: 'ROUTE_UNKNOWN_GROUP',
        file: path.relative(root, path.join(base, entry.name)),
        message: `"${entry.name}" is not a route group. Put routes in ${GROUPS.map((g) => `${path.basename(base)}/${g}/`).join(' or ')}`,
      });
    }
  }

  for (const group of GROUPS) {
    const groupDir = path.join(base, group);
    for await (const file of walk(groupDir)) {
      const rel = path.relative(root, file).replace(/\\/g, '/');
      const parts = path.relative(groupDir, file).replace(/\\/g, '/').replace(/\.js$/, '').split('/');
      if (parts.at(-1) === 'index') parts.pop();
      const { segments, problem } = parseSegments(parts);
      if (problem) {
        problems.push({ code: 'ROUTE_INVALID_PATH', file: rel, message: `${rel}: ${problem}` });
        continue;
      }
      found.push({ file, rel, group, url: urlOf(group, segments), segments, shape: shapeOf(group, segments) });
    }
  }

  // two files, one URL
  const byShape = new Map();
  for (const route of found) {
    const other = byShape.get(route.shape);
    if (other) {
      const same = other.url === route.url;
      problems.push({
        code: 'ROUTE_CONFLICT',
        file: route.rel,
        message: same
          ? `${route.rel} and ${other.rel} both serve ${route.url}`
          : `${route.rel} (${route.url}) and ${other.rel} (${other.url}) match the same requests with different parameter names`,
      });
    } else {
      byShape.set(route.shape, route);
    }
  }

  found.sort((a, b) => compareRoutes({ segments: [{ kind: 'static', text: a.group }, ...a.segments] }, { segments: [{ kind: 'static', text: b.group }, ...b.segments] }));
  return { routes: found, problems };
}

// Static and dynamic routes that can match the same URL, e.g. /profile and /:id.
// The static one wins (see the ordering rule above); this is for information.
export function shadowedPairs(routes) {
  const pairs = [];
  for (const dyn of routes) {
    if (!dyn.segments.some((s) => s.kind === 'param')) continue;
    for (const stat of routes) {
      if (stat === dyn || stat.group !== dyn.group || stat.segments.length !== dyn.segments.length) continue;
      if (dyn.segments.every((s, i) => s.kind === 'param' || (stat.segments[i].kind === 'static' && stat.segments[i].name === s.name))) {
        if (stat.segments.some((s, i) => s.kind === 'static' && dyn.segments[i].kind === 'param')) pairs.push({ static: stat, dynamic: dyn });
      }
    }
  }
  return pairs;
}

// ── Collecting the routes a loaded router really contains ─────────────────

const join = (a, b) => ('/' + [a, b].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')).replace(/\/{2,}/g, '/');
const asList = (p) => (Array.isArray(p) ? p : [p]);
const show = (p) => (p instanceof RegExp ? `/${p.source}/` : String(p));

// Express keeps the path of a route, but forgets where a nested router was mounted. So the
// router of each route file (and every router mounted into it) gets its own use() wrapped, on
// that instance only, to remember the mount paths. Returns the Map child router -> [paths].
export function trackMounts(router) {
  const mounts = new Map();
  const wrapped = new WeakSet();
  const wrap = (r) => {
    if (wrapped.has(r)) return;
    wrapped.add(r);
    const original = r.use;
    r.use = function use(...args) {
      const first = args[0];
      const hasPath = typeof first === 'string' || first instanceof RegExp || Array.isArray(first);
      for (const handler of (hasPath ? args.slice(1) : args).flat()) {
        if (typeof handler === 'function' && Array.isArray(handler.stack)) {
          mounts.set(handler, [...(mounts.get(handler) ?? []), ...(hasPath ? asList(first) : ['/'])]);
          wrap(handler); // later use() calls on the child are seen too
        }
      }
      return original.apply(this, args);
    };
  };
  wrap(router);
  return mounts;
}

// Every { method, path } below a router, with nested routers resolved. `prefix` is where the
// router itself is mounted.
//
// Limits (also in the docs): a router that was filled with use() calls before it was passed to
// a tracked router is walked, but where *its* children are mounted is unknown, so those paths
// contain "…" and are marked `approximate`. Paths given as RegExp are shown as /source/ and marked
// `pattern`. Routes added by code that bypasses the router (app-level hooks) are not listed.
export function collectRoutes(router, mounts = new Map(), prefix = '', seen = new Set()) {
  if (seen.has(router)) return [];
  seen.add(router);
  const out = [];
  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).map((m) => (m === '_all' ? 'ALL' : m.toUpperCase()));
      for (const p of asList(layer.route.path)) {
        const sub = show(p);
        for (const method of methods) out.push({ method, path: join(prefix, sub === '/' ? '' : sub) || '/', ...(p instanceof RegExp && { pattern: true }) });
      }
    } else if (Array.isArray(layer.handle?.stack)) {
      const known = mounts.get(layer.handle);
      for (const mount of known?.length ? known : ['…']) {
        const nested = collectRoutes(layer.handle, mounts, join(prefix, mount === '…' ? '…' : show(mount)), seen);
        out.push(...nested.map((r) => (known?.length ? r : { ...r, approximate: true })));
      }
    }
  }
  seen.delete(router);
  return out;
}
