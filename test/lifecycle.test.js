import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, tick } from './helpers/silent.js';
import { ResourceStack } from '../src/core/resources.js';
import { LifecycleError, PortInUseError } from '../src/index.js';

const silent = { warn() {}, error() {}, info() {}, debug() {} };
const listenOn = (port = 0) =>
  new Promise((resolve) => {
    const s = net.createServer().listen(port, '127.0.0.1', () => resolve(s));
  });

// ── ResourceStack ──

test('closers run last-registered-first, and running them twice does not reverse them again', async () => {
  const order = [];
  const stack = new ResourceStack({ log: silent });
  stack.add(() => order.push('a'));
  stack.add(() => order.push('b'));
  stack.add(() => order.push('c'));
  await stack.closeAll();
  await stack.closeAll();
  assert.deepEqual(order, ['c', 'b', 'a']);
});

test('a failing closer is reported and the others still run', async () => {
  const order = [];
  const stack = new ResourceStack({ log: silent });
  stack.add(() => order.push('db'), { name: 'db' });
  stack.add(() => { throw new Error('redis down'); }, { name: 'redis' });
  stack.add(() => order.push('queue'), { name: 'queue' });
  const result = await stack.closeAll();
  assert.deepEqual(order, ['queue', 'db']);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].name, 'redis');
});

test('a hung closer is bounded by the timeout; the rest are still started', async () => {
  const stack = new ResourceStack({ log: silent });
  let started = false;
  stack.add(() => { started = true; }, { name: 'last-in-first-out-victim' });
  stack.add(() => new Promise(() => {}), { name: 'hangs' });
  const t0 = Date.now();
  const result = await stack.closeAll({ timeoutMs: 80 });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(result.pending, ['hangs']);
  assert.deepEqual(result.abandoned, ['last-in-first-out-victim']);
  await tick(20);
  assert.equal(started, true);
});

test('registered while closing: closed too; registered after: runs at once', async () => {
  const order = [];
  const stack = new ResourceStack({ log: silent });
  stack.add(() => order.push('first'));
  stack.add(() => { order.push('second'); stack.add(() => order.push('late-while-closing')); });
  await stack.closeAll();
  assert.deepEqual(order, ['second', 'late-while-closing', 'first']);
  stack.add(() => order.push('after'));
  await stack.settled();
  assert.equal(order.at(-1), 'after');
});

// ── createApp rollback ──

test('a plugin that fails rolls back the resources of the plugins before it', async () => {
  const events = [];
  const db = (app, ctx) => ctx.onClose(() => events.push('db closed'), { name: 'db' });
  const redis = (app, ctx) => ctx.onClose(() => events.push('redis closed'), { name: 'redis' });
  const broken = () => { throw new Error('plugin exploded'); };
  await assert.rejects(build({ plugins: [db, redis, broken] }), /plugin exploded/);
  assert.deepEqual(events, ['redis closed', 'db closed']);
});

test('rollback survives a closer that throws, and the original error is the one reported', async () => {
  const events = [];
  const a = (app, ctx) => ctx.onClose(() => events.push('a'));
  const b = (app, ctx) => ctx.onClose(() => { throw new Error('cleanup failed'); });
  const boom = () => { throw new Error('init failed'); };
  await assert.rejects(build({ plugins: [a, b, boom] }), (err) => err.message === 'init failed' && err.cleanupErrors.length === 1);
  assert.deepEqual(events, ['a']);
});

// ── start / stop ──

test('start() twice returns the same server and registers the signal handlers once', async () => {
  const before = process.listenerCount('SIGTERM');
  const { start, stop } = await build();
  const [a, b] = await Promise.all([start(), start()]);
  assert.equal(a, b);
  assert.equal(await start(), a);
  assert.equal(process.listenerCount('SIGTERM'), before + 1);
  await stop();
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('start() after stop() is refused', async () => {
  const app = await build();
  await app.start({ signals: false });
  await app.stop();
  await assert.rejects(app.start(), LifecycleError);
  assert.equal(app.state, 'stopped');
});

test('a port that is taken rejects start() with PortInUseError and releases resources', async () => {
  const blocker = await listenOn();
  const events = [];
  const plugin = (app, ctx) => ctx.onClose(() => events.push('closed'));
  const app = await build({ port: blocker.address().port, plugins: [plugin] });
  await assert.rejects(app.start({ signals: false }), (err) => err instanceof PortInUseError && err.port === blocker.address().port && /free port/.test(err.hint));
  assert.deepEqual(events, ['closed']);
  assert.equal(app.state, 'stopped');
  blocker.close();
});

test('stop() is idempotent: handlers run once however often it is called', async () => {
  let closed = 0;
  const app = await build({ plugins: [(a, ctx) => ctx.onClose(() => closed++)] });
  await app.start({ signals: false });
  const results = await Promise.all([app.stop(), app.stop(), app.stop()]);
  assert.equal(closed, 1);
  assert.equal(results[0], results[1]);
});

test('stop() works on an app that was never started', async () => {
  let closed = 0;
  const app = await build({ plugins: [(a, ctx) => ctx.onClose(() => closed++)] });
  await app.stop();
  assert.equal(closed, 1);
});

test('the shutdown timeout covers onClose handlers, not only connections', async () => {
  const app = await build({ shutdownTimeout: 150, plugins: [(a, ctx) => ctx.onClose(() => new Promise(() => {}), { name: 'stuck' })] });
  await app.start({ signals: false });
  const t0 = Date.now();
  const result = await app.stop();
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(result.forced, true);
  assert.deepEqual(result.pending, ['stuck']);
});

test('an in-flight request finishes before the server closes, and /ready reports stopping', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const routes = (app, ctx) => app.get('/slow', async (req, res) => { await gate; res.json({ done: true }); });
  const app = await build({ plugins: [routes] });
  const server = await app.start({ signals: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  const pending = fetch(`${base}/slow`).then((r) => r.json());
  await tick(50);
  const stopping = app.stop();
  await tick(30);
  assert.equal(app.state, 'stopping');
  release();
  assert.deepEqual(await pending, { done: true });
  assert.equal((await stopping).forced, false);
});

test('a handler registered after the app stopped is run immediately', async () => {
  const app = await build();
  await app.stop();
  let ran = false;
  app.ctx.onClose(() => { ran = true; });
  await tick(10);
  assert.equal(ran, true);
});

// ── Signals (separate process) ──

const script = fileURLToPath(new URL('./fixtures/lifecycle/signals.mjs', import.meta.url));
const runChild = (mode) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('READY') && !child.sent) {
        child.sent = true;
        if (mode === 'both') { child.kill('SIGTERM'); child.kill('SIGINT'); } else child.kill('SIGTERM');
      }
    });
    child.on('exit', (code) => resolve({ code, out }));
  });

test('SIGTERM and SIGINT together shut down once and exit 0', async () => {
  const { code, out } = await runChild('both');
  assert.equal(code, 0);
  assert.equal(out.match(/CLOSED/g)?.length, 1);
});

test('a hung handler makes the signal shutdown exit with 1 after the timeout', async () => {
  const { code, out } = await runChild('hang');
  assert.equal(code, 1);
  assert.match(out, /READY/);
});
