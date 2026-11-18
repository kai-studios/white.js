# Protocols

A *protocol* is a contract between components: what a signed call looks like, what a plugin exports, what a library expects from another. White.js versions protocols separately from everything else.

| Level | Example | What changing it means |
| --- | --- | --- |
| Framework | `white-js@0.4.0` | a release of White.js |
| Protocol | `meta@3.0` | a new generation of a contract |
| Library | `white-auth@2.4.0` | a release of a library |

None of them implies another. Updating White.js does not change a protocol; updating a library does not move the app to a new generation. The generation in use is a **recorded decision** (`white.protocols.json`), changed only by `white migrate`.

White.js itself implements two protocols:

| Protocol | Contract |
| --- | --- |
| `mesh@1.0` | signed service-to-service calls (`WHITE1` signature, `x-white-*` headers, `/_white/*` endpoints) |
| `plugin@1.0` | a plugin is a module whose default export is `function (app, ctx, options)` |

Any library can define more (the examples in these docs use a `meta` protocol).

## Version numbers

`MAJOR.MINOR`, for example `3.0`. There is no patch level: fixing a bug in an implementation is a library release, not a protocol change.

- **MAJOR**: a new *generation*. A breaking change. Peers on different generations are not assumed to understand each other. Publish a migration from the previous generation.
- **MINOR**: an additive change inside a generation. Everything that worked on `2.0` keeps working on `2.1`. The manifest of `2.1` says so with `compatibility.protocols: ["meta@2.0"]`.
- A published version is **immutable**. A change in content is a new version; the registry refuses two different definitions of one `name@version`.
- A removal needs a period of support first: `current` → `supported` → `deprecated` → `removed`. A security problem may skip straight to `blocked`.

## The protocol manifest

One declarative object per version. It is data: nothing in it is executed.

```json
{
  "name": "meta",
  "version": "3.0",
  "status": "current",
  "compatibility": {
    "white": ">=0.4.0",
    "protocols": []
  },
  "replaces": "meta@2.0",
  "migration": {
    "from": "meta@2.0",
    "to": "meta@3.0",
    "strategy": "automatic",
    "id": "meta-2.0-to-3.0",
    "integrity": "sha256-…"
  },
  "coexistence": "multiple"
}
```

| Field | Meaning |
| --- | --- |
| `name`, `version` | lowercase name (`a-z`, digits, `-`), `MAJOR.MINOR` |
| `status` | see below |
| `compatibility.white` | semver range of White.js versions this protocol version works with |
| `compatibility.protocols` | other versions of the same protocol this one interoperates with. **Explicit; never inferred, never transitive** |
| `replaces` | the version this one supersedes |
| `migration` | how to get here: `from`, `to` (must be this version), `strategy` (`automatic` or `manual`), `id`, `integrity` (SHA-256 of the migration module, see [migrations](migrations.md)) |
| `coexistence` | `multiple` (default): libraries may use different generations in one process. `single`: all users must agree on one |
| `implementation` | `"builtin"` for protocols White.js implements. Others are implemented by packages (`white.provides`) |
| `advisory` | `{ id, severity, summary, url }`: the security advisory, for blocked versions |
| `deprecation` | `{ since, removeIn, message }` |
| `reason` | why a version is blocked when there is no advisory (a compatibility block) |

### Statuses

| Status | Meaning | In `white doctor` | At start-up |
| --- | --- | --- | --- |
| `current` | the recommended version | none | works |
| `supported` | works, but not the recommended one | info | works |
| `deprecated` | works; migrate soon | warning | works, logs a warning |
| `blocked` | **forbidden** (security or compatibility) | critical if it has an `advisory`, else error | **refuses to start** unless an exception is granted (with `enforce: 'critical'`, only blocked versions that have an `advisory`) |
| `removed` | no longer supported | error | refuses to start (`protocols.enforce: 'error'`) |

## Who declares what

Everything is declared in files; no library code is loaded to find out.

**A library's `package.json`** (the `white` field):

```json
{
  "name": "white-auth",
  "version": "2.4.0",
  "white": {
    "framework": ">=0.4.0",
    "protocols": {
      "meta": { "required": "2.0", "supported": ["2.0", "3.0"] }
    },
    "provides": { "meta": ["2.0", "3.0"] },
    "defines": [],
    "migrations": "./migrations.js"
  }
}
```

- `protocols.<name>.required`: the generation the library uses unless told otherwise. It must be listed in `supported`.
- `protocols.<name>.supported`: every generation it can speak. Default: just `required`.
- `protocols.<name>.optional`: `true` makes an unregistered protocol a warning instead of an error.
- `provides`: the generations this package **implements**. A protocol version used by someone but implemented by nobody is an error (`implementation-missing`).
- `defines`: protocol manifests this package introduces.
- `migrations`: path (inside the package) of the module with the migrations of protocols it defines.

**`white.protocols.json`** in the project (managed by `white migrate`, committed like a lockfile):

```json
{
  "version": 1,
  "use": { "meta": "3.0" },
  "libraries": { "white-auth": { "meta": "3.0" } }
}
```

- `use`: the generation the application's own code uses (`ctx.protocols.selected('meta')`).
- `libraries.<name>`: the generation a library should use. Without an entry the library uses its `required`. A library never changes generation by itself, and the selection must be one it `supports`.

**`white.config.js`** (policy):

```js
export default {
  protocols: {
    enforce: 'error',          // 'error' (default) | 'critical' | 'off': what stops the app from starting
    block: ['meta@2.0'],       // block a version in this project
    allow: [                   // a documented, temporary exception for a blocked/removed version
      { protocol: 'meta@2.0', reason: 'migration planned for sprint 42', until: '2027-01-31' },
    ],
    definitions: [],           // protocol manifests defined by the project itself
  },
};
```

An exception needs a written `reason`; with `until` it expires and then shows up as a warning and the version is blocked again. An allowed version is still reported by `white doctor`.

## How compatibility is decided

The Compatibility Engine reads the declarations and answers, for each user of a protocol (a library, or the application), which generation it uses and whether that is acceptable. A generation is acceptable when it is registered, not `blocked` or `removed`, its `compatibility.white` includes the running White.js, and some package implements it.

- **Coexistence.** If `white-auth` uses `meta@2.0` and `white-mesh` uses `meta@3.0`, that is fine as long as both generations are acceptable. For protocols with `coexistence: "single"` the engine instead looks for a generation every user supports: none is an `error` (`generation-conflict`), several is a warning that names the best one.
- **Nothing is assumed.** Two versions interoperate only if one manifest lists the other. `2.0 ~ 2.1` and `2.1 ~ 2.2` say nothing about `2.0` and `2.2`.
- **Recommendations.** If a library supports the current generation, the engine suggests switching it (`switch`, and tells whether the migration is `automatic` or `manual`). If it does not, it suggests updating the library (`update-library`), which is an npm matter and outside `white migrate`.

### Finding codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `blocked-version` | critical / error | a blocked version is in use. Updating the library does not fix it while the app keeps using the protocol version |
| `blocked-allowed`, `removed-allowed` | warning | in use, excused by `protocols.allow` |
| `exception-expired` | warning | an `allow` entry has passed its `until` date |
| `removed-version` | error | in use but removed |
| `deprecated-version` | warning | in use, deprecated |
| `not-current` | info | in use, supported, a newer one is current |
| `framework-incompatible`, `library-framework-incompatible` | error | White.js outside the declared range |
| `implementation-missing` | error | nothing installed implements that version |
| `protocol-unknown`, `version-unknown` | error (warning if `optional`) | not in the registry |
| `selection-unsupported` | error | `white.protocols.json` selects a generation the library does not support |
| `generation-conflict`, `generation-mismatch` | error / warning | `coexistence: "single"` violated |
| `migration-unavailable` | error | a blocked or removed version with no migration path |
| `registry-invalid`, `manifest-invalid`, `selection-invalid` | error | the declarations themselves are wrong |

## Security

- **Blocking.** A version with `status: "blocked"` and an `advisory` is a critical finding. At start-up the app refuses to run, **before any plugin code is imported**, unless `protocols.allow` grants an exception.
- **A library update is not a fix.** The finding says so: while the application keeps using a vulnerable generation, updating the library that speaks it changes nothing.
- **Forced migration.** `white migrate` without a target plans exactly the migrations that blocked or removed versions force.
- **Separate channels.** Deprecation is a warning; a security problem is critical and has its own exit code (2) in `white doctor`.
- **Migration modules** are verified before they are imported: see [migrations](migrations.md#integrity-and-provenance).
- Backward compatibility never outranks security: a blocked version stays blocked.

## In the running app

```js
export default (app, ctx) => {
  ctx.protocols.registry.current('meta');               // manifest of the current version
  ctx.protocols.report;                                 // the compatibility report made at start-up
  ctx.protocols.selected('meta');                       // what the application chose, or undefined
  ctx.protocols.for('white-auth').version('meta');      // '2.0': what a library uses, fixed for the process
  ctx.protocols.supports('meta', '3.0');                // usable and implemented
  ctx.protocols.fingerprint;                            // hash of the registry, also in /_white/manifest
};
```

- The registry is created **per app** (no module-level state), filled at start-up from files, then **frozen**: every mutating method throws. Two apps in one process do not share protocol state.
- It serialises to JSON and has a `fingerprint`, so separate processes or services can compare what they know. `GET /_white/manifest` of a service includes `protocols.fingerprint` and the generations in use.
- The check runs once, at start-up. Routes do not need to check compatibility.
- `ctx.protocols.for(lib).version(p)` returns the same answer on every call, and throws if that generation became unusable. A library therefore never switches generation while running.

## Command line

```bash
white protocol list                 # every protocol and version, status, who uses it
white protocol info meta            # all versions of one protocol
white protocol info meta@3.0        # one version: compatibility, migration, implementers
white protocol integrity ./migrations.js   # the value for "migration.integrity"
white doctor                        # includes the compatibility report
```
