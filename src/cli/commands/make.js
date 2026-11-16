import fs from 'node:fs';
import path from 'node:path';
import * as ui from '../../ui/index.js';
import { addPlugin } from '../config-edit.js';

const USAGE = `Usage:
  white make route <path> [--api] [--no-view]   white make route blog/[slug]
  white make plugin <name>                      white make plugin analytics`;

const NAME = /^[A-Za-z0-9_[\]-]+(?:\/[A-Za-z0-9_[\]-]+)*$/;

function write(root, rel, content, created) {
  const file = path.join(root, rel);
  if (fs.existsSync(file)) throw new Error(`${rel} already exists`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  created.push(rel);
}

// Creates the files of a route or a plugin. Returns the list of created paths.
// Pure file work with no output, so it is easy to test.
export function makeFiles(kind, name, { api = false, view = true, dirs = {} } = {}, root = process.cwd()) {
  if (!NAME.test(name)) throw new Error(`Invalid name "${name}". Use letters, numbers, "-", "_" and "/" for folders.`);
  const created = [];
  const routes = dirs.routes ?? 'server/routes';
  const views = dirs.views ?? 'app/views';

  if (kind === 'route') {
    const rel = `${routes}/${api ? 'api' : 'client'}/${name}.js`;
    const segments = name.split('/');
    const isIndex = segments.at(-1) === 'index';
    const urlParts = segments.map((s) => s.replace(/^\[(.+)\]$/, ':$1')).filter((s, i, all) => !(i === all.length - 1 && s === 'index'));
    const url = (api ? '/api' : '') + '/' + urlParts.join('/');

    if (api) {
      write(root, rel, `export default (router) => {\n  router.get('/', (req, res) => {\n    res.json({ ok: true });\n  });\n};\n`, created);
    } else {
      const viewName = segments.map((s) => s.replace(/^\[(.+)\]$/, '$1')).join('/');
      const title = viewName.split('/').at(-1).replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
      const params = [...name.matchAll(/\[(.+?)\]/g)].map((m) => m[1]);
      const data = [`title: '${title === 'Index' ? 'Home' : title}'`, ...params.map((p) => `${p}: req.params.${p}`)].join(', ');
      write(root, rel, `export default (router) => {\n  router.get('/', (req, res) => {\n    res.render('${viewName}', { ${data} });\n  });\n};\n`, created);
      if (view) {
        const depth = viewName.split('/').length - 1;
        const layout = (depth ? '../'.repeat(depth) : './') + 'layout';
        const body = `<% layout('${layout}', it) %>\n<h1><%= it.title %></h1>\n`;
        write(root, `${views}/${viewName}.eta`, body, created);
      }
    }
    return { created, url: isIndex && urlParts.length === 0 ? (api ? '/api' : '/') : url };
  }

  if (kind === 'plugin') {
    const id = name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''));
    const rel = `server/plugins/${name}.js`;
    write(
      root,
      rel,
      `// A plugin is a function that receives the Express app, the White.js context and options.\n// ctx: { config, root, dev, abs, log, routes, cache, onClose }\nexport default function ${id}(app, ctx, options = {}) {\n  app.use((req, res, next) => {\n    // runs on every request, before the routes\n    next();\n  });\n}\n`,
      created,
    );
    return { created, entry: `./${rel}` };
  }

  throw new Error(`Unknown kind "${kind}". Use "route" or "plugin".`);
}

export async function makeCommand(args, root = process.cwd()) {
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const [kind, name, ...rest] = args.filter((a) => !a.startsWith('--'));
  if (!kind || !name || rest.length) {
    console.log(USAGE);
    process.exit(kind ? 1 : 0);
  }

  let config = {};
  try {
    const { loadConfig } = await import('../../index.js');
    config = await loadConfig(root);
  } catch {
    // no config yet: defaults are fine
  }

  try {
    const result = makeFiles(kind, name, { api: flags.has('--api'), view: !flags.has('--no-view'), dirs: config.dirs }, root);
    console.log('');
    for (const file of result.created) console.log(`  ${ui.t.success(ui.sym.ok)}  ${ui.t.muted('created')} ${file}`);

    if (result.entry) {
      const configFile = path.join(root, 'white.config.js');
      const source = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
      const edit = addPlugin(source, result.entry);
      if (edit.manual) {
        console.log(`  ${ui.t.warn(ui.sym.fail)}  Add ${ui.t.accent(`'${result.entry}'`)} to "plugins" in white.config.js yourself.`);
      } else {
        if (edit.changed) fs.writeFileSync(configFile, edit.source);
        console.log(`  ${ui.t.success(ui.sym.ok)}  ${ui.t.muted('registered in')} white.config.js`);
      }
    } else {
      console.log(`\n  ${ui.t.muted('URL')}  ${ui.t.accent(result.url)}`);
    }
    console.log('');
  } catch (error) {
    console.error(`\n  ${ui.t.error(ui.sym.err)}  ${error.message}\n`);
    process.exit(1);
  }
}
