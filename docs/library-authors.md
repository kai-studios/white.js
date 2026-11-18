# For library authors

How to make a White.js library take part in protocol compatibility, support several generations of a protocol, and ship a migration.

## 1. Declare what you use

In `package.json`:

```json
{
  "name": "white-auth",
  "version": "2.4.0",
  "white": {
    "framework": ">=0.4.0",
    "protocols": {
      "meta": { "required": "2.0", "supported": ["2.0", "3.0"] }
    }
  }
}
```

- `required` is the generation you use by default. It must be in `supported`.
- `supported` lists every generation you can really speak. Do not list one you have not tested.
- `framework` is optional; it is a semver range.

Raising `supported` is a normal release. Dropping a generation from `supported` is a breaking change for anyone who selected it: bump your major version.

Everything is read from `package.json`; White.js never imports your library to find this out, and it checks it **before** your plugin code runs.

## 2. Support several generations

The app decides, not the library: `white.protocols.json` may select `meta@3.0` for you, otherwise you get `required`. Ask which one, once, at start-up:

```js
export default function whiteAuth(app, ctx, options) {
  const meta = ctx.protocols.for('white-auth').version('meta');   // '2.0' or '3.0'

  const adapter = { '2.0': metaV2, '3.0': metaV3 }[meta];         // explicit: no guessing, no fallback
  if (!adapter) throw new Error(`white-auth does not support meta@${meta}`);

  app.use('/auth', createRouter(adapter));
}
```

Rules:

- Pick the implementation **once** and keep it. `for().version()` gives the same answer for the life of the process, and throws if that generation became unusable.
- Do not switch generations at runtime, and do not "detect" the generation from data. An implicit switch is exactly what this system exists to prevent.
- Keep each generation's code separate (`metaV2`, `metaV3`) so one can be deleted when you drop it.

A runnable example is in [examples/multi-generation-library](examples/multi-generation-library).

## 3. Declare what you implement

If your package *implements* a protocol version (so that others can use it), say so:

```json
"white": { "provides": { "meta": ["2.0", "3.0"] } }
```

A protocol version that is used but provided by nobody is reported as `implementation-missing`. White.js provides `mesh@1.0` and `plugin@1.0` itself.

## 4. Define a protocol

If your package introduces a protocol, add its manifests under `white.defines`, one per version ([manifest reference](protocols.md#the-protocol-manifest)):

```json
"white": {
  "provides": { "meta": ["2.0", "3.0"] },
  "defines": [
    { "name": "meta", "version": "2.0", "status": "deprecated", "compatibility": { "white": ">=0.3.0" } },
    {
      "name": "meta", "version": "3.0", "status": "current",
      "compatibility": { "white": ">=0.4.0" },
      "replaces": "meta@2.0",
      "migration": { "from": "meta@2.0", "to": "meta@3.0", "strategy": "automatic",
                     "id": "meta-2.0-to-3.0", "integrity": "sha256-…" }
    }
  ],
  "migrations": "./migrations.js"
}
```

### Choosing version numbers

- Additive change (new optional field, new message): **minor**. Old consumers must keep working. List the previous minor in `compatibility.protocols`.
- Anything that breaks an existing consumer: **major**, with a migration from the previous generation (`automatic` if the change can be applied mechanically and safely, `manual` otherwise).
- Never change a published manifest. Publish a new version. To deprecate, publish the new generation, then release a package version whose manifest for the old one has `status: "deprecated"` (and `deprecation.message`). To block for security, set `status: "blocked"` with an `advisory`.
- Keep at least one release with both generations `supported` before deprecating the old one, so users can move at their own pace.

### `coexistence`

Leave the default (`multiple`) when libraries on different generations can run side by side in one process. Use `single` only when they cannot (for example both would own the same global resource); White.js then demands that all users agree on one generation.

## Writing a migration

A migration module exports one migration or an array of them. `defineMigration` validates it (a plain object with the same fields works too).

```js
// migrations.js
import { defineMigration } from 'white-js';

export default defineMigration({
  id: 'meta-2.0-to-3.0',          // must equal migration.id of meta@3.0
  protocol: 'meta', from: '2.0', to: '3.0',
  title: 'meta.tags is now meta.labels',

  async plan(project) { … },       // read-only; returns { operations, manual }
  async verify(project) { … },     // optional; returns { ok, problems }
});
```

### `plan(project)`

Describe the change; do not make it. `project` offers:

| Member | Purpose |
| --- | --- |
| `read(file)`, `readJson(file)`, `exists(file)` | read project files (paths relative to the project root) |
| `list(dir, { ext })` | files below a folder, sorted, without `node_modules`, `.git`, `.white` |
| `edit(file, newContent, reason)` | operation: replace an existing file |
| `create(file, content, reason)` | operation: add a new file (fails if it exists) |
| `editJson(file, fn, reason)` | operation: edit a JSON file through a function |
| `config`, `protocols.users`, `protocols.selection` | resolved config and what uses the protocol (read-only data) |

Return `{ operations: [...], manual: [{ file?, message, hint? }] }`.

Requirements:

- **Idempotent.** If the project is already migrated, return no operations. Detect your own output.
- **Honest about what you cannot do.** If a change could alter behaviour, do not guess: return a `manual` item that explains it.
- **Small, reviewable edits.** Users read the diff. Do not reformat files you do not need to change.
- **Never delete.** There is no delete operation. Do not rewrite a file down to a stub: edits that remove more than half of a file are refused.
- Do not edit `package.json` or lockfiles. If users must install something, say so in a `manual` item.
- When several hops are needed (`2.0 → 3.0 → 4.0`), each migration sees the files as the previous hop left them.

### `verify(project)`

Runs after the files are written, on the migrated project. Return `{ ok: false, problems: ['…'] }` and everything is rolled back.

### Shipping it

1. Put the module in your package and set `white.migrations` to its path (inside the package).
2. Run `white protocol integrity ./migrations.js` and put the result in `migration.integrity` of the manifest. Do this on the **published** file; any change after that makes it unverified.
3. Test it: build a throw-away project with fixtures (see `test/helpers/meta.js` in the White.js repository) and run `createMigrationEngine({ root, config }).plan({ target })`, then `.apply(plan)`.

A migration you do not ship as code (`strategy: "manual"`, no module) is still valid: the plan tells users that this step is theirs and links it to the protocol version. Document the steps in your release notes.
