# Routing

Routes are files. The layout is read in one place (`src/core/routes.js`), without importing any route, so `white doctor` applies the same rules as the app.

```
server/routes/
  api/                  group "api": URLs get the /api prefix
    users.js            /api/users
    users/index.js      /api/users          (conflicts with users.js, see below)
    users/[id].js       /api/users/:id
  client/               group "client": no prefix
    index.js            /
    about.js            /about
    blog/[slug].js      /blog/:slug
```

A route file exports a function: `export default (router, ctx) => { router.get('/', handler); }`. `router` is an Express router, mounted at the file's URL.

## Rules

- **Groups.** The first folder must be `api` or `client`. Any other folder or file at the top of the routes folder is an error: *"admin" is not a route group*.
- **Missing folders are fine.** No routes folder, or no `api/` or `client/` inside it, means no routes. Any other file system error (permissions, I/O) is raised, not ignored.
- **`index.js`** stands for its folder.
- **Dynamic segments** are written `[name]`, and `name` must be letters, digits and `_`, not starting with a digit. `[id]`, `[user_id]`: yes. `[1x]`, `[]`, `[a-b]`: errors.
- **Special characters.** `: * ( ) { } [ ] ? + !` and `\` mean something in Express paths. Outside the `[name]` form they are refused in file and folder names.
- **Conflicts** are errors: two files that give the same URL (`users.js` and `users/index.js`), or the same shape with different parameter names (`blog/[id].js` and `blog/[slug].js`).

All problems of a layout are reported together, at start-up (`RouteLoadError`) and by `white doctor`.

## Priority

Mounting order is deterministic and does not depend on the file system or the locale. Routes are compared segment by segment:

1. a **static** segment comes before a **dynamic** one;
2. segments of the same kind are compared by code point;
3. a shorter path comes before a longer one that starts the same way.

So `/about`, `/profile`, `/profile/settings`, `/:id`, `/:id/settings` is the order. `/profile` is always tried before `/:id`, and `/profile/settings` before `/:id/settings`. The group is part of the order (`api` before `client`).

`white doctor` lists every place where a static route and a dynamic route can match the same URL, as information (the static one wins).

## `ctx.routes`

Every route a file registered, with its method, final path, source file, used by `white routes` and the start-up banner:

```js
{ method: 'GET', path: '/api/shop/v1/items', file: 'server/routes/api/shop.js' }
```

Collected from what the router really contains:

- routers nested in routers, with the mount paths joined;
- routes with several methods (`router.route('/x').get().post()`, `router.all()` → `ALL`);
- array paths (`router.get(['/a', '/b'], …)` is two entries);
- paths that are regular expressions are shown as `/source/` and carry `pattern: true`.

### Limits of the listing

Express remembers the path of a route but not where a router was mounted, so White.js wraps `use()` on the router it hands to your file (that one instance only) to observe mounts. Consequently:

- Mounts made through that router, and through routers mounted into it afterwards, are exact.
- A router that was **already filled with `use()` calls before it was passed in** (`sub.use('/deep', deep); router.use('/v1', sub)`) is still walked, but the mount path of its children is unknown. Such entries contain `…` (`/v1/…/x`) and carry `approximate: true`. `white doctor --deep` counts them.
- Middleware registered with `app.use` in plugins, and handlers that are not routers, are not routes and are not listed.

The listing is for diagnostics; it has no effect on what is served.
