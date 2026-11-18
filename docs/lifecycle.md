# Lifecycle

`createApp(config, root)` builds the app and returns `{ app, ctx, start, stop, state, server }`. `white run` does `createApp()` then `start()`; you can do the same in your own program.

```js
import { loadConfig, createApp } from 'white-js';

const { start, stop } = await createApp(await loadConfig(process.cwd()), process.cwd());
const server = await start();            // resolves when the port is open
// …
await stop();                            // programmatic shutdown; does not exit the process
```

## States

```
created ──start()──> starting ──> running ──stop()──> stopping ──> stopped
   └──────────────────────────stop()───────────────────────┘
```

`app.state` (also `ctx.state`) is one of `created`, `starting`, `running`, `stopping`, `stopped`. While `createApp()` is still building, `ctx.state` reads `created`.

## `start({ signals = true })`

- Resolves with the `http.Server` once it listens.
- **Repeated calls** return the same promise, so never a second server and never a second set of signal handlers. The options of the second call are ignored.
- After `stop()` has begun, `start()` rejects with `LifecycleError`.
- **A port that is taken** rejects with `PortInUseError` (`.port`, a hint on what to do). Other listen errors reject with `ListenError`. In both cases the resources the plugins opened are released (as in a normal stop) and the app ends up `stopped`.
- `signals: true` registers `SIGTERM` and `SIGINT` handlers, once, and removes them when the app stops. Several apps in one process share one listener: the first signal stops all of them, then the process exits (`0`, or `1` if any shutdown was forced). `signals: false` leaves signals to you.
- `config.host` limits the address to listen on (default: all interfaces).

## `ctx.onClose(fn, { name }?)`

Registers cleanup: close a database, flush a queue. `fn` may be async.

- Handlers run **one at a time, last registered first**.
- A handler that throws (or rejects) is logged with its `name`; the rest still run. The errors are returned from `stop()` as `result.errors`.
- A handler that never settles cannot hold the shutdown longer than the timeout (below). The handlers behind it are still started, but not waited for.
- Registered **while shutdown is running** (for example by a plugin that was still starting): it is closed too, in turn.
- Registered **after shutdown has finished**: it runs immediately, its errors are logged, and a warning says so.

## Failed start-up: rollback

If anything throws while the app is being built — a plugin, a route file, a blocked protocol — the `onClose` handlers registered so far run in reverse order, then the **original error** is thrown. Cleanup problems are logged and attached as a non-enumerable `err.cleanupErrors`; they never replace the original error.

```
plugin 1 opens the database   → registers its closer
plugin 2 opens Redis          → registers its closer
plugin 3 throws
                              → Redis is closed, then the database, then createApp() rejects with plugin 3's error
```

## `stop({ reason })` and shutdown

`stop()` is idempotent: every caller gets the same promise and the sequence runs once. It resolves with `{ forced, errors, pending, abandoned }`.

1. State becomes `stopping`. Responses carry `Connection: close`, and `/ready` answers `503 { stopping: true }`, so a load balancer stops sending traffic. `/health` is unaffected.
2. The server stops accepting connections; idle keep-alive connections are closed, and again every 100 ms for connections that become idle.
3. The `onClose` handlers run.
4. When the handlers are done and the last connection has ended: state `stopped`.

**`shutdownTimeout`** (default 10 000 ms) covers **all** of it: waiting for requests *and* for handlers. When it runs out:

- remaining connections are closed;
- one log line (`warn`) says how long the limit was, how many connections were still open, and **which handlers had not finished** or were abandoned;
- `stop()` resolves with `forced: true`, and the signal path exits with code `1`.

A stop on an app that was never started simply runs the handlers.

## Signals

`SIGTERM` and `SIGINT` together, or the same signal twice, start **one** shutdown. Later signals are logged and ignored. Exit code `0` for a clean shutdown, `1` when it was forced or failed.

## Testing

`createTestClient()` builds the app, listens on a random port, and its `close()` closes the server and then runs the `onClose` handlers. For tests of your own lifecycle use `createApp({ …, port: 0, host: '127.0.0.1' })` and `start({ signals: false })`.
