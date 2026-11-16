# White.js

A thin web framework built on Express 5, made for sites and services that talk to each other: signed calls between servers, peers, events and health checks are built in.

## Requirements

- Node.js 20.12 or newer
- Git, to install examples

## Run a project

Install White.js in your application and add these scripts to `package.json`:

```json
{
  "scripts": {
    "start": "white run",
    "dev": "white run dev"
  }
}
```

Then run `npm run dev` for development or `npm start` for production.

## Install an example

```sh
npx white-js install example:site
```

The wizard asks for a folder, whether to install dependencies and whether to create a git repository, then shows live progress. Existing directories are never overwritten.

Skip the questions with arguments:

```sh
white install example:site my-site --yes          # defaults, no questions
white install example:site my-site --no-install   # only download
white install example:site my-site --git          # also run git init
```

Without a terminal (CI, pipes) the installer prints plain lines and uses the defaults. Set `NO_COLOR=1` to disable colors or `WHITE_NO_ANIMATION=1` to disable decorative animation.

## CLI

The package exposes two binaries, `white` and `white-js`, both pointing at `bin/white.js`.

| Command | What it does |
| --- | --- |
| `white run` | start the site |
| `white run dev` | start with restart on changes |
| `white install example:<name> [folder]` | create a project from an example |
| `white plugin add <name...>` | install and enable plugins |
| `white plugin remove <name...>` | remove plugins |
| `white routes` | list every route and the file it comes from |
| `white make route <path> [--api] [--no-view]` | create a route and its view |
| `white make plugin <name>` | create a local plugin and register it |
| `white mesh status` | check that every peer answers and accepts our signature |
| `white mesh keygen` | print a new random secret for a service link |
| `white doctor` | check the project for problems |

## Development

### Live reload

`white run dev` refreshes the browser by itself:

- a changed view reloads the page;
- a changed `.css` file in `public/` is swapped in place, so scroll position and page state stay;
- a changed server file restarts the server, and the open page reloads once it is back.

It is active only in `white run dev`. Turn it off with `dev: { reload: false }` in `white.config.js`.

### Generators

```sh
white make route about                 # server/routes/client/about.js + app/views/about.eta
white make route "blog/[slug]"         # GET /blog/:slug, with req.params.slug passed to the view
white make route status --api          # server/routes/api/status.js, answers JSON
white make plugin analytics            # server/plugins/analytics.js, added to white.config.js
```

Existing files are never overwritten.

### `white routes` and `white doctor`

`white routes` prints every method, URL and source file. `white doctor` checks the Node version, `package.json`, the config and required environment variables, the folders, that every route loads, duplicate routes and that the port is free. It exits with 1 when something is broken, so it also works in CI.

## Helpers

### Templates

Available in every view as `it.w.*`. `it.path` is the current URL path.

| Helper | Example | Result |
| --- | --- | --- |
| `date(value, options?)` | `it.w.date(post.date)` | `November 16, 2026` |
| `number(value, options?)` | `it.w.number(1234.5)` | `1,234.5` |
| `truncate(text, length?, tail?)` | `it.w.truncate(post.body, 140)` | cut at a word |
| `classes(...parts)` | `it.w.classes('btn', { 'btn--big': big })` | `btn btn--big` |
| `active(current, href, { exact }?)` | `it.w.active(it.path, '/blog')` | `true` on `/blog/post` |
| `slug(text)` | `it.w.slug('Crème brûlée')` | `creme-brulee` |
| `json`, `url`, `asset` | see the example site | safe embedding, safe links, cache busting |

`date` and `number` follow `locale` in `white.config.js` (default `'en'`).

### Cache

```js
export default (router, ctx) => {
  router.get('/', async (req, res) => {
    // runs once even when many requests arrive together; a failure is not cached
    const posts = await ctx.cache.wrap('posts', () => db.posts(), '30s');
    res.json(posts);
  });
};
```

`ctx.cache` is shared by all routes and plugins. For a separate cache use `createCache({ ttl: '5m', max: 500 })`. It has `get`, `set`, `has`, `delete`, `clear`, `wrap` and `size`; the least recently used entry goes first. Durations are milliseconds or strings such as `'30s'`, `'5m'`, `'1h'`, `'2d'`.

`cacheControl('1h')` is a route middleware that sets `Cache-Control` for browsers and CDNs; `cacheControl(0)` sends `no-store`.

### Environment

```js
import { defineEnv } from 'white-js';

export const env = defineEnv({
  PORT: 'port',
  DATABASE_URL: 'url',
  DEBUG: { type: 'boolean', default: false },
  LEVEL: ['debug', 'info', 'warn'],              // one of
  SENTRY_DSN: { type: 'url', optional: true },
});
```

Types: `string` (default), `number`, `integer`, `port`, `boolean`, `url`. Every problem is reported at once, and the result is frozen.

### Shutdown

```js
export default (app, ctx) => {
  const db = connect();
  ctx.onClose(() => db.end());   // runs on SIGTERM / SIGINT
};
```

On shutdown the server stops accepting requests, runs the `onClose` handlers (last registered first), lets running requests finish and exits with 0. Connections still open after `shutdownTimeout` (10 seconds by default) are closed and the exit code is 1.

## Services

White.js can connect servers into one system: a site and its API, several back-end services, or separate sites that share data. Turn it on with `mesh` in `white.config.js`. Without it nothing below is active and nothing in your app changes.

```js
// web/white.config.js
export default {
  mesh: {
    name: 'web',                                   // this service
    peers: {
      billing: {
        url: process.env.BILLING_URL,              // 'http://billing:3000'
        secret: process.env.BILLING_SECRET,        // `white mesh keygen`
        required: true,                            // /ready fails while billing is down
      },
    },
  },
};
```

```js
// billing/white.config.js: the same link seen from the other side, with the same secret
export default {
  mesh: {
    name: 'billing',
    peers: { web: { url: process.env.WEB_URL, secret: process.env.BILLING_SECRET } },
  },
};
```

The name a service gives itself must be the name its peers use for it. A mismatch shows up as a rejected signature in `white mesh status`.

### Calling another service

```js
export default (router, ctx) => {
  router.get('/invoices', async (req, res) => {
    const billing = ctx.mesh.peer('billing');
    const invoices = await billing.json('GET', '/api/internal/invoices', { query: { page: 1 } });
    res.json(invoices);
  });
};
```

| Call | Result |
| --- | --- |
| `peer.get/post/put/patch/delete/head(path, options)` | `{ status, ok, headers, text, json, attempts, ms }` for any answer from the service |
| `peer.json(method, path, options)` | the parsed JSON body, or an `UpstreamError` when the answer is not 2xx |

Options: `json`, `form`, `body`, `query`, `headers`, `timeout`, `retries`, `idempotent`, `retryStatus`, `signal`.

- **Signed.** Every request carries an HMAC-SHA256 signature over the method, path and query, body hash, time, a one-time nonce, the caller and the receiver. The secret is never sent. Changing anything, replaying a request, or sending it to another service fails.
- **Request id.** The id of the request being handled goes along automatically, so one user action can be followed through the logs of every service.
- **Retries.** `GET`, `HEAD`, `PUT`, `DELETE` and `OPTIONS` are retried (exponential backoff with jitter, `Retry-After` respected) on network errors and 408, 429, 502, 503, 504. Other methods are retried only with `idempotent: true`. Every attempt gets a new signature.
- **Timeouts and errors.** The default timeout is 5 seconds. A service that cannot be reached, times out, or has an open circuit throws an `UpstreamError` (502, 503 or 504), which a route that does not catch it turns into that status.
- **Circuit breaker.** After 5 failures in a row (network errors, timeouts, 5xx) calls to that peer fail at once for 30 seconds, then one probe is let through. Tune with `breaker: { threshold, cooldown }` or turn off with `breaker: false`.
- Redirects are never followed, paths cannot leave the peer's address, and responses over 5 MB are refused (`maxResponse`).

Defaults for all peers go next to `name` (`timeout`, `retries`, `retryDelay`, `breaker`) and can be overridden per peer.

### Receiving calls

URLs under `/internal` and `/api/internal` (the `protect` list) accept only signed requests from known services. A file `server/routes/api/internal/invoices.js` is therefore reachable by your other services and by nobody else:

```js
export default (router, ctx) => {
  router.get('/', (req, res) => {
    res.json(db.invoices({ for: req.service.name })); // req.service.name is the verified caller
  });

  // limit one route to some services
  router.delete('/:id', ctx.mesh.auth({ allow: ['admin'] }), handler);
};
```

Outside the protected prefixes, use `ctx.mesh.auth()` (or `serviceAuth()` from `white-js`) on any route. Unknown callers, bad signatures, old timestamps (`skew`, 60 seconds) and replayed requests all get the same `401`; the real reason is in the log. Repeated failures from one address are answered with `429`. Signed requests skip the normal rate limit, since they are authenticated instead.

Signed requests must have no body or a JSON or form body (the signature covers the exact bytes). A caller must be a peer or listed in `accept`.

Signatures prove who is calling and that nothing changed; they do not hide the content. Use https between servers that do not share a private network. Replay protection is kept in memory of each instance; with several instances of one service, pass `nonces` (an object with `claim(key, ttlMs) -> boolean`, for example on Redis `SET NX PX`).

### Events

```js
// billing: react to events from other services
ctx.mesh.on('user.created', async (event) => {
  await createAccount(event.data.id);       // event: { id, type, data, from, at }
});
ctx.mesh.on('user.*', handler);              // prefix; '*' matches everything

// users: tell the others
const result = await ctx.mesh.emit('user.created', { id: 7 });
// { id, delivered: ['billing'], failed: [] }
```

`emit` goes to every peer (or `{ to: ['billing'] }`; a peer with `events: false` is skipped) and is retried. A handler that throws makes the sender retry, and a delivered event id is remembered for an hour, so each handler runs once per event. `{ wait: false }` returns immediately. There is no stored queue: an event is lost if the sender dies before delivery, so for data that must not be lost write it to your database first and send the event after.

### Health, discovery and status

- `ctx.mesh.status()` pings every peer: `[{ name, ok, ms, version, breaker, error }]`.
- Peers with `required: true` are part of `/ready`, so an instance without a needed service leaves the load balancer. `/health` stays independent of peers.
- Every service answers (to known services only) at `/_white/ping` and `/_white/manifest`, which lists its routes, event patterns, version and the `meta` you set.
- `ctx.mesh.addPeer(name, { url, secret })`, `removePeer(name)` and `setPeerUrl(name, url)` change peers at runtime, for example from a service registry.
- `white mesh status` does the ping from the command line and exits with 1 when a peer is down.

### Standalone client

Code that is not a route (a worker, a script) can use the same client:

```js
import { createClient } from 'white-js';
const billing = createClient({ name: 'billing', from: 'worker', url: process.env.BILLING_URL, secret: process.env.BILLING_SECRET });
```

## Testing

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestClient } from 'white-js/test';

test('status', async () => {
  const client = await createTestClient();          // runs on a free port, logging off
  const res = await client.get('/api/status');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  await client.close();
});
```

`get`, `post`, `put`, `patch` and `delete` take `{ json, form, body, headers }` and return `{ status, headers, text, json, location }`. Redirects are not followed, so you can assert on them, and cookies are kept between calls. 
To test services that call each other, start them together in one process. Links are two-way and get random secrets:

```js
import { createTestCluster } from 'white-js/test';

const cluster = await createTestCluster({
  web:     { config: { dirs: { routes: 'test/web/routes' } }, peers: ['billing'] },
  billing: { config: { dirs: { routes: 'test/billing/routes' } } },
});
const res = await cluster.services.web.get('/invoices');   // goes through the real mesh
await cluster.close();
```

Run the library's own tests with `npm test`.

## Project layout

```
bin/white.js        CLI entry point (the "bin" field in package.json)
src/
  index.js          public API
  core/             app, config, errors, plugin and route loader, logger
  http/             security, views, helpers, validation, built-in error page
  mesh/             service-to-service: signing, client, circuit breaker, auth, events, peers
  cli/              command router, commands (run, install, plugin, routes, make, mesh, doctor), config editing
  dev/              live reload
  utils/            cache, duration
  test.js           createTestClient ("white-js/test")
  ui/               terminal UI, no dependencies
    core/           ansi, easing, Live renderer, key input, theme
    components/     spinner, progress bar, gradient, logo
    prompts/        text, select, confirm
    tasks.js        live checklist with progress
    session.js      intro, outro, log, note
```

## Terminal UI

`src/ui` is a small set of components built for the installer and the startup banner. Animations are time-based, redraw one block in place with a single write per frame (wrapped in synchronized output) and skip frames that did not change. The progress bar has 1/8-cell resolution and eases toward its target, so it never jumps.
