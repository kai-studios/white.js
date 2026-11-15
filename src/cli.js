#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, createApp, ConfigError } from './index.js';

const [cmd, ...args] = process.argv.slice(2);
const mode = args[0];

if (cmd === 'plugin') {
  const { pluginCommand } = await import('./plugin-cli.js');
  await pluginCommand(args);
} else if (cmd === 'install') {
  const { installExample } = await import('./install-example.js');
  installExample(args);
} else if (cmd !== 'run') {
  console.log('Usage:\n  white run [dev]\n  white install example:<name>\n  white plugin add <name...>\n  white plugin remove <name...>');
  process.exit(cmd ? 1 : 0);
} else if (mode === 'dev' && !process.env.WHITE_CHILD) {
  // dev: restart on file changes
  const self = fileURLToPath(import.meta.url);
  const here = path.dirname(self);

  // Project files to watch (routes are loaded dynamically, so list them explicitly)
  const watch = ['server', 'white.config.js', '.env'].filter((p) => fs.existsSync(path.resolve(p)));
  // While developing the framework itself (not installed from node_modules), watch it too
  if (!here.includes(`${path.sep}node_modules${path.sep}`)) watch.push(here);

  const child = spawn(
    process.execPath,
    ['--watch', ...watch.map((p) => `--watch-path=${p}`), self, 'run', 'dev'],
    { stdio: 'inherit', env: { ...process.env, WHITE_CHILD: '1', NODE_ENV: 'development' } },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  if (mode !== 'dev') process.env.NODE_ENV ??= 'production';
  try {
    const config = await loadConfig();
    const { start } = await createApp(config);
    await start();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`White.js: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
