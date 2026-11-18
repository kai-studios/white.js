# Multi-generation library

Two small packages that show the whole protocol workflow. They are used by `test/examples.test.js`, so they stay correct.

- `white-meta-example`: **defines** the example protocol `meta` (generations `2.0` deprecated, `3.0` current), implements both, and ships the verified migration between them.
- `white-auth-example`: a library that **supports both generations** and picks one explicitly at start-up.

Try it in a project (copy both folders into `node_modules`, or install them from a path):

```bash
white doctor                      # meta@2.0 is deprecated; white-auth-example uses it
white protocol info meta@3.0
white migrate meta@3.0 --analyze  # which files change, with diffs
white migrate meta@3.0            # apply; white.protocols.json now selects meta@3.0
white doctor                      # clean
```

`white-auth-example` answers `GET /auth/whoami` with the generation it is using: `2.0` before the migration, `3.0` after.
