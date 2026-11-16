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

## Project layout

```
bin/white.js        CLI entry point (the "bin" field in package.json)
src/
  index.js          public API
  core/             app, config, errors, plugin and route loader, logger
  http/             security, views, helpers, validation, built-in error page
  cli/              command router, commands (run, install, plugin), config editing
  ui/               terminal UI, no dependencies
    core/           ansi, easing, Live renderer, key input, theme
    components/     spinner, progress bar, gradient, logo
    prompts/        text, select, confirm
    tasks.js        live checklist with progress
    session.js      intro, outro, log, note
```

## Terminal UI

`src/ui` is a small set of components built for the installer and the startup banner. Animations are time-based, redraw one block in place with a single write per frame (wrapped in synchronized output) and skip frames that did not change. The progress bar has 1/8-cell resolution and eases toward its target, so it never jumps.
