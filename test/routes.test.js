import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { scanRoutes, shadowedPairs, trackMounts, collectRoutes } from '../src/core/routes.js';
import { RouteLoadError } from '../src/index.js';
import { createTestClient } from '../src/test.js';
import { tmpProject } from './helpers/project.js';

const route = 'export default (router) => router.get("/", (req, res) => res.json({ ok: true }));\n';
const scan = async (files) => {
  const p = tmpProject(files);
  const result = await scanRoutes(path.join(p.root, 'routes'), p.root);
  p.cleanup();
  return result;
};

test('a missing routes folder, or a missing group folder, is not an error', async () => {
  assert.deepEqual(await scan({}), { routes: [], problems: [] });
  const only = await scan({ 'routes/api/users.js': route });
  assert.deepEqual(only.problems, []);
  assert.deepEqual(only.routes.map((r) => r.url), ['/api/users']);
});

test('file names become URLs', async () => {
  const { routes } = await scan({
    'routes/client/index.js': route,
    'routes/client/blog/[id].js': route,
    'routes/client/about.js': route,
    'routes/api/index.js': route,
    'routes/api/users/index.js': route,
  });
  assert.deepEqual(routes.map((r) => r.url).sort(), ['/', '/about', '/api', '/api/users', '/blog/:id']);
});

test('an unknown group, and files outside a group, are reported clearly', async () => {
  const { problems } = await scan({ 'routes/admin/x.js': route, 'routes/stray.js': route });
  assert.deepEqual(problems.map((p) => p.code), ['ROUTE_UNKNOWN_GROUP', 'ROUTE_UNKNOWN_GROUP']);
  assert.match(problems[0].message, /not a route group/);
});

test('invalid parameter names and special characters are found when the files are scanned', async () => {
  const { problems, routes } = await scan({
    'routes/client/[1id].js': route,
    'routes/client/[].js': route,
    'routes/client/[a-b].js': route,
    'routes/client/a:b.js': route,
    'routes/client/ok/[good_name].js': route,
  });
  assert.equal(problems.length, 4);
  assert.ok(problems.every((p) => p.code === 'ROUTE_INVALID_PATH'));
  assert.deepEqual(routes.map((r) => r.url), ['/ok/:good_name']);
});

test('two files for one URL, or one shape with two parameter names, conflict', async () => {
  const same = await scan({ 'routes/api/users.js': route, 'routes/api/users/index.js': route });
  assert.equal(same.problems[0].code, 'ROUTE_CONFLICT');
  assert.match(same.problems[0].message, /both serve \/api\/users/);
  const names = await scan({ 'routes/client/blog/[id].js': route, 'routes/client/blog/[slug].js': route });
  assert.match(names.problems[0].message, /different parameter names/);
});

test('mounting order is deterministic: static before dynamic, then by name', async () => {
  const { routes } = await scan({
    'routes/client/[id].js': route,
    'routes/client/profile.js': route,
    'routes/client/profile/settings.js': route,
    'routes/client/[id]/settings.js': route,
    'routes/client/about.js': route,
  });
  assert.deepEqual(routes.map((r) => r.url), ['/about', '/profile', '/profile/settings', '/:id', '/:id/settings']);
});

test('shadowedPairs lists where a static route competes with a dynamic one', async () => {
  const { routes } = await scan({ 'routes/client/[id].js': route, 'routes/client/profile.js': route, 'routes/client/other/x.js': route });
  const pairs = shadowedPairs(routes);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].static.url, '/profile');
  assert.equal(pairs[0].dynamic.url, '/:id');
});

test('/profile wins over /:id when the app serves both', async () => {
  const p = tmpProject({
    'routes/client/[id].js': 'export default (r) => r.get("/", (req, res) => res.send("dynamic " + req.params.id));',
    'routes/client/profile.js': 'export default (r) => r.get("/", (req, res) => res.send("static"));',
  });
  const client = await createTestClient({ dirs: { routes: 'routes' } }, { root: p.root });
  assert.equal((await client.get('/profile')).text, 'static');
  assert.equal((await client.get('/42')).text, 'dynamic 42');
  await client.close();
  p.cleanup();
});

test('createApp refuses an invalid route layout with a diagnostic error', async () => {
  const p = tmpProject({ 'routes/oops/x.js': route });
  await assert.rejects(createTestClient({ dirs: { routes: 'routes' } }, { root: p.root }), (err) => err instanceof RouteLoadError && err.code === 'ROUTE_UNKNOWN_GROUP' && /not a route group/.test(err.message));
  p.cleanup();
});

test('a file system error other than "not found" is passed up, not swallowed', async () => {
  const p = tmpProject({ 'routes/api/x.js': route });
  const real = fs.promises.readdir;
  fs.promises.readdir = async (dir, ...rest) => {
    if (String(dir).endsWith(path.join('routes', 'api'))) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return real(dir, ...rest);
  };
  try {
    await assert.rejects(scanRoutes(path.join(p.root, 'routes'), p.root), (err) => err instanceof RouteLoadError && err.code === 'EACCES' && /permission denied/.test(err.message));
  } finally {
    fs.promises.readdir = real;
  }
  p.cleanup();
});

// ── nested routers ──

test('nested routers, several methods and path arrays are all collected', () => {
  const router = express.Router();
  const mounts = trackMounts(router);
  const sub = express.Router();
  sub.get('/list', () => {});
  sub.route('/item').get(() => {}).post(() => {});
  const deep = express.Router();
  deep.get('/x', () => {});
  router.use('/v1', sub);
  sub.use('/deep', deep);
  router.get(['/a', '/b'], () => {});
  router.all('/any', () => {});
  const list = collectRoutes(router, mounts).map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(list, ['ALL /any', 'GET /a', 'GET /b', 'GET /v1/deep/x', 'GET /v1/item', 'GET /v1/list', 'POST /v1/item']);
});

test('a router built with children before it was passed in is walked; unknown mount paths are marked', () => {
  const router = express.Router();
  const mounts = trackMounts(router);
  const sub = express.Router();
  const deep = express.Router();
  deep.get('/x', () => {});
  sub.use('/deep', deep); // happens before sub is mounted: the mount path is not observable
  router.use('/v1', sub);
  const [r] = collectRoutes(router, mounts);
  assert.equal(r.path, '/v1/…/x');
  assert.equal(r.approximate, true);
});

test('the startup banner list (ctx.routes) includes routes of nested routers', async () => {
  const p = tmpProject({
    'routes/api/shop.js': 'import express from "express";\nexport default (r) => { const s = express.Router(); s.get("/items", (q, a) => a.json([])); r.use("/v1", s); };',
  }, { link: true });
  const client = await createTestClient({ dirs: { routes: 'routes' } }, { root: p.root });
  assert.deepEqual(client.ctx.routes.map((x) => `${x.method} ${x.path}`), ['GET /api/shop/v1/items']);
  assert.equal((await client.get('/api/shop/v1/items')).status, 200);
  await client.close();
  p.cleanup();
});
