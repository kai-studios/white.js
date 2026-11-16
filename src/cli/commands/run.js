import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/white.js', import.meta.url));
const SRC = fileURLToPath(new URL('../../', import.meta.url));

export async function run([mode]) {
  if (mode === 'dev' && !process.env.WHITE_CHILD) return dev();
  if (mode !== 'dev') process.env.NODE_ENV ??= 'production';

  const { loadConfig, createApp, ConfigError } = await import('../../index.js');
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

// dev: restart on file changes
function dev() {
  // Project files to watch (routes are loaded dynamically, so list them explicitly)
  const watch = ['server', 'white.config.js', '.env'].filter((p) => fs.existsSync(path.resolve(p)));
  // While developing the framework itself (not installed from node_modules), watch it too
  if (!SRC.includes(`${path.sep}node_modules${path.sep}`)) watch.push(SRC);

  const child = spawn(
    process.execPath,
    ['--watch', ...watch.map((p) => `--watch-path=${p}`), BIN, 'run', 'dev'],
    { stdio: 'inherit', env: { ...process.env, WHITE_CHILD: '1', NODE_ENV: 'development' } },
  );
  child.on('exit', (code) => process.exit(code ?? 0));
}
