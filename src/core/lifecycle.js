import http from 'node:http';
import { LifecycleError, PortInUseError, ListenError } from './white-error.js';

// The life of an app, as an explicit state machine:
//
//   created ──start()──> starting ──> running ──stop()──> stopping ──> stopped
//      └─────────────────stop()──────────────────────────────┘
//
// start()  is idempotent: while starting or running it returns the same promise (so never a
//          second server); after stop() it rejects with a LifecycleError.
// stop()   is idempotent too: every caller gets the same promise, shutdown runs once. The
//          timeout covers the whole shutdown (connections AND onClose handlers).
// Signal handlers are registered once, by the first start(), and removed when the app stops.

export const STATE = Object.freeze({
  CREATED: 'created',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
});

const SIGNALS = ['SIGTERM', 'SIGINT'];

// One process has one set of signals, so apps started with signals: true share one listener.
// The first signal stops all of them, then the process exits (1 if any shutdown was forced).
const watched = new Set();
let signalHandlers = null;
let signalled = false;

function watch(entry) {
  watched.add(entry);
  if (signalHandlers) return;
  signalHandlers = Object.fromEntries(
    SIGNALS.map((name) => [
      name,
      () => {
        if (signalled) {
          for (const e of watched) e.log.info({ signal: name }, 'Already shutting down, ignoring the signal');
          return;
        }
        signalled = true;
        Promise.all([...watched].map((e) => e.stop({ reason: name })))
          .then((results) => process.exit(results.some((r) => r.forced) ? 1 : 0))
          .catch(() => process.exit(1));
      },
    ]),
  );
  for (const name of SIGNALS) process.on(name, signalHandlers[name]);
}

function unwatch(entry) {
  watched.delete(entry);
  if (watched.size || !signalHandlers) return;
  for (const name of SIGNALS) process.off(name, signalHandlers[name]);
  signalHandlers = null;
}

export function createLifecycle({ app, config, log, resources, onListening }) {
  let state = STATE.CREATED;
  let server = null;
  let startPromise = null;
  let stopPromise = null;
  const entry = { log, stop: (options) => stop(options) };

  function listen() {
    server = http.createServer(app);
    return new Promise((resolve, reject) => {
      const failed = (err) => {
        server.off('listening', ready);
        reject(err.code === 'EADDRINUSE' ? new PortInUseError(config.port, { cause: err }) : new ListenError(config.port, err));
      };
      const ready = () => {
        server.off('error', failed);
        // errors after a successful start must not crash the process unlogged
        server.on('error', (err) => log.error({ err }, 'HTTP server error'));
        resolve(server);
      };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(config.port, ...(config.host ? [config.host] : []));
    });
  }

  function start({ signals = true } = {}) {
    if (state === STATE.STOPPING || state === STATE.STOPPED) {
      return Promise.reject(new LifecycleError(`Cannot start: the app is ${state}`, { hint: 'Create a new app with createApp().' }));
    }
    if (startPromise) return startPromise;
    state = STATE.STARTING;
    startPromise = listen().then(
      (s) => {
        // stop() may have been called while the port was being opened
        if (state !== STATE.STARTING) return s;
        state = STATE.RUNNING;
        if (signals) watch(entry);
        onListening?.(s);
        return s;
      },
      async (err) => {
        // a failed start must not leak what the plugins opened
        const cleanup = await stop({ reason: 'start failed' });
        if (cleanup.errors.length) err.cleanupErrors = cleanup.errors;
        throw err;
      },
    );
    return startPromise;
  }

  const countConnections = () =>
    new Promise((resolve) => (server?.listening ? server.getConnections((err, n) => resolve(err ? undefined : n)) : resolve(0)));

  function stop({ reason = 'stop' } = {}) {
    stopPromise ??= shutdown(reason);
    return stopPromise;
  }

  async function shutdown(reason) {
    const wasRunning = state === STATE.RUNNING || state === STATE.STARTING;
    state = STATE.STOPPING;
    if (wasRunning) log.info({ reason }, 'Shutting down');
    const result = { forced: false, errors: [], pending: [], abandoned: [] };
    const limit = config.shutdownTimeout;

    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, limit, 'timeout'); // keeps the process alive until the deadline
    });

    let sweep;
    const work = (async () => {
      let closed = Promise.resolve();
      if (server?.listening) {
        closed = new Promise((resolve) => server.close(() => resolve()));
        // connections that become idle after their last response must not keep us waiting
        sweep = setInterval(() => server.closeIdleConnections?.(), 100);
        sweep.unref?.();
        server.closeIdleConnections?.();
      }
      const closing = await resources.closeAll({ timeoutMs: limit });
      Object.assign(result, { errors: closing.errors, pending: closing.pending, abandoned: closing.abandoned, forced: closing.timedOut });
      await closed;
    })();

    const winner = await Promise.race([work.then(() => 'done'), deadline]);
    clearTimeout(timer);
    clearInterval(sweep);

    if (winner === 'timeout' || result.forced) {
      result.forced = true;
      if (!result.pending.length && resources.active) result.pending = [resources.active];
      const open = await countConnections();
      log.warn(
        { limitMs: limit, openConnections: open, unfinishedHandlers: result.pending, abandonedHandlers: result.abandoned },
        `Shutdown did not finish within ${limit} ms: closing remaining connections`,
      );
      server?.closeAllConnections?.();
    }

    state = STATE.STOPPED;
    unwatch(entry);
    return result;
  }

  return {
    start,
    stop,
    get state() {
      return state;
    },
    get server() {
      return server;
    },
  };
}
