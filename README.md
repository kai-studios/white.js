# White.js

A thin web framework built on Express 5.

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

`get`, `post`, `put`, `patch` and `delete` take `{ json, form, body, headers }` and return `{ status, headers, text, json, location }`. Redirects are not followed, so you can assert on them, and cookies are kept between calls. Run the library's own tests with `npm test`.

## Project layout

```
bin/white.js        CLI entry point (the "bin" field in package.json)
src/
  index.js          public API
  core/             app, config, errors, plugin and route loader, logger
  http/             security, views, helpers, validation, built-in error page
  cli/              command router, commands (run, install, plugin, routes, make, doctor), config editing
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
