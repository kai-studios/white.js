import fs from 'node:fs';
import path from 'node:path';
import * as ui from '../../ui/index.js';
import { exec } from '../proc.js';

const defaultExamples = {
  site: 'https://github.com/kai-studios/white-generator.git',
};

const USAGE = 'Usage: white install example:<name> [folder] [--yes] [--no-install] [--git]';

// ── Helpers ───────────────────────────────────────────────────────────────

function parseArgs(args) {
  const opts = { positional: [], yes: false, install: undefined, git: undefined };
  for (const arg of args) {
    if (arg === '-y' || arg === '--yes') opts.yes = true;
    else if (arg === '--install') opts.install = true;
    else if (arg === '--no-install') opts.install = false;
    else if (arg === '--git') opts.git = true;
    else if (arg === '--no-git') opts.git = false;
    else if (arg.startsWith('-')) opts.unknown = arg;
    else opts.positional.push(arg);
  }
  return opts;
}

function fail(message, details) {
  console.error(`\n  ${ui.t.error(ui.sym.err)}  ${message}`);
  if (details) console.error(ui.t.muted(details.split('\n').slice(-12).map((l) => '     ' + l).join('\n')));
  console.error('');
  process.exit(1);
}

function folderProblem(name, cwd) {
  const valid =
    /^[\p{L}\p{N}_][\p{L}\p{N} ._-]*$/u.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
  if (!valid) return 'Use letters, numbers, spaces, "-", "_" or "."';
  if (fs.existsSync(path.resolve(cwd, name))) return 'This folder already exists';
}

// npx / pnpm dlx / bunx / yarn dlx tell us who started them
function detectPackageManager() {
  const agent = process.env.npm_config_user_agent ?? '';
  const name = /^(pnpm|yarn|bun)\//.exec(agent)?.[1] ?? 'npm';
  const scripts = { npm: (s) => (s === 'start' ? 'npm start' : `npm run ${s}`), pnpm: (s) => `pnpm ${s}`, yarn: (s) => `yarn ${s}`, bun: (s) => `bun run ${s}` };
  return { name, run: scripts[name], flags: name === 'npm' ? ['--no-audit', '--no-fund'] : [] };
}

const quote = (name) => (/\s/.test(name) ? `"${name}"` : name);

// git prints "Receiving objects: 42%" and "Resolving deltas: 10%" on stderr
function cloneExample(repository, checkout, onProgress) {
  return exec('git', ['clone', '--depth', '1', '--progress', repository, checkout], {
    onLine(line) {
      const m = /(Receiving objects|Resolving deltas):\s+(\d+)%/.exec(line);
      if (!m) return;
      const value = Number(m[2]) / 100;
      onProgress(m[1] === 'Receiving objects' ? value * 0.85 : 0.85 + value * 0.15);
    },
  }).then(() => onProgress(1));
}

// ── Command ───────────────────────────────────────────────────────────────

export async function installExample(args, { examples = defaultExamples } = {}) {
  const opts = parseArgs(args);
  const [specifier, folderArg, ...extra] = opts.positional;

  if (!specifier) {
    console.log(USAGE);
    process.exit(0);
  }
  if (extra.length || opts.unknown) {
    console.log(USAGE);
    process.exit(1);
  }

  const match = /^example:([a-z0-9][a-z0-9-]*)$/.exec(specifier);
  if (!match) fail(`Invalid example: ${specifier}`);

  const exampleName = match[1];
  const repository = examples[exampleName];
  if (!repository) fail(`Unknown example "${exampleName}". Available examples: ${Object.keys(examples).join(', ')}`);

  const cwd = process.cwd();
  const fancy = ui.caps.interactive;
  const ask = fancy && !opts.yes;
  const pm = detectPackageManager();

  if (fancy) await ui.intro(`Create a new ${ui.t.accent(exampleName)} project`);

  // 1. Questions (skipped with --yes, arguments or when there is no terminal)
  let folder = folderArg;
  if (folder === undefined) {
    folder = ask
      ? await ui.text({
          message: 'Project folder',
          placeholder: exampleName,
          validate: (v) => folderProblem(v, cwd),
          hint: (v) => path.resolve(cwd, v),
        })
      : exampleName;
  }
  const problem = folderProblem(folder, cwd);
  if (problem) fail(`${problem}: ${path.resolve(cwd, folder)}`);

  const install = opts.install ?? (ask ? await ui.confirm({ message: `Install dependencies with ${pm.name}?` }) : true);
  const git = opts.git ?? (ask ? await ui.confirm({ message: 'Initialize a git repository?' }) : false);

  // 2. Work
  const target = path.resolve(cwd, folder);
  const staging = fs.mkdtempSync(path.join(cwd, `.white-install-${exampleName}-`));
  const checkout = path.join(staging, 'repo');
  const cleanup = () => fs.rmSync(staging, { recursive: true, force: true });
  const onSigint = () => {
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  const started = performance.now();
  let created = false;
  let installed = false;
  const steps = [
    {
      title: 'Downloading template',
      run: ({ progress }) => cloneExample(repository, checkout, progress),
    },
    {
      title: 'Preparing files',
      run: () => {
        fs.rmSync(path.join(checkout, '.git'), { recursive: true, force: true });
        fs.renameSync(checkout, target);
        created = true;
      },
    },
    {
      title: `Installing dependencies ${ui.t.muted(`(${pm.name})`)}`,
      skip: !install,
      run: async ({ message }) => {
        await exec(pm.name, ['install', ...pm.flags], { cwd: target, onLine: message });
        installed = true;
      },
    },
    {
      title: 'Initializing git repository',
      skip: !git,
      run: ({ message }) => exec('git', ['init', '--quiet'], { cwd: target }).catch(() => message('skipped: git is not available')),
    },
  ];

  try {
    await ui.tasks('Creating your project', steps);
  } catch (error) {
    cleanup();
    if (!created) fail(`Could not create the project: ${error.message}`, error.output);
    fail(
      `${error.message}\n     Project files are in "${folder}". To retry: cd ${quote(folder)} && ${pm.name} install`,
      error.output,
    );
  } finally {
    process.off('SIGINT', onSigint);
  }
  cleanup();

  // 3. Result
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const next = [`cd ${quote(folder)}`, ...(installed ? [] : [`${pm.name} install`]), pm.run('dev')];
  if (fancy) {
    ui.note('Next steps', [
      ...next.map((l) => ui.t.accent(l)),
      '',
      ui.t.muted(`${pm.run('start')}  ·  production`),
    ]);
    ui.outro(`Ready in ${seconds}s`);
  } else {
    console.log(`\nDone! Project created in "${folder}".`);
    for (const line of next) console.log(`  ${line}`);
    console.log(`  ${pm.run('start')}`);
  }
}
