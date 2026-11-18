# Plugins

A plugin is a module whose default export is `function (app, ctx, options)` (this is the `plugin@1.0` protocol). Plugins are listed in `white.config.js`:

```js
export default {
  plugins: [
    'white-auth',                      // an npm package
    ['white-cache', { ttl: 60 }],      // with options
    './server/plugins/audit.js',       // a file, relative to the project root
    (app, ctx) => { /* inline */ },    // a function
  ],
};
```

## How a plugin is found

One algorithm, used by `white run`, `white plugin add` and `white doctor`, always starting at **your project**, never at the place White.js is installed:

- **Paths** (`./x`, `../x`, absolute): the file, with `.js`, `.mjs` or `.cjs` added if missing; or a folder with a `package.json` (`main`) or an `index` file.
- **Package names** (`name`, `@scope/name`, `name/subpath`): the `node_modules` folders from the project upwards, like Node does.
  - With an **`exports`** field it is followed exactly: the sugar forms, subpaths, patterns (`./lib/*`), `null` targets (blocked) and nested **conditions**. The `import` conditions (`node`, `import`, `module-sync`, `default`) are tried first, because that is how the plugin is loaded. If there is no `import` entry but there is a `require` one, the package is loaded as CommonJS.
  - Without `exports`: `main`, then `index.js`.
- ESM-only packages, CommonJS packages, and CommonJS compiled from ESM (`exports.default = fn`) all work.

Resolving reads files only. Nothing is executed until the plugin is loaded.

### Errors

| Code | When |
| --- | --- |
| `PLUGIN_NOT_FOUND` | the package or file does not exist. Names the folders searched and suggests `npm install <name>` |
| `PLUGIN_ENTRY_NOT_EXPORTED` | the package has `exports`, but not for what was asked (no main entry, subpath not exported) |
| `PLUGIN_LOAD_FAILED` | the module threw while loading; the message says where |
| `PLUGIN_INVALID` | the module has no default function |

## Protocol checks

If a plugin package has a `white` field in its `package.json` ([docs](protocols.md)), its protocol needs are checked against the registry **before the package is imported**. A plugin that requires a blocked or removed generation, or one nobody implements, stops the start-up and its code never runs.

A local plugin file cannot be inspected without importing it. It may export its declaration, which is checked before the plugin function is called:

```js
export const white = { protocols: { meta: { required: '3.0' } } };
export default (app, ctx) => { … };
```

## `white doctor`

The doctor resolves every plugin in the config and reports declarations that are not valid, packages that cannot be found, packages that are found but not declared in `package.json`, and unresolvable `exports`. It does so without importing any plugin. `white doctor --deep` loads the app for real.
