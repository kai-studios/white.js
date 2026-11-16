import crypto from 'node:crypto';
import * as ui from '../../ui/index.js';

const USAGE = 'Usage:\n  white mesh status    ask every peer if it answers and accepts our signature\n  white mesh keygen    print a new random secret';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

export async function meshCommand([action], root = process.cwd()) {
  if (action === 'keygen') {
    // Only the secret goes to stdout, so `white mesh keygen >> secret.txt` and $(white mesh keygen) work
    console.log(crypto.randomBytes(32).toString('base64url'));
    if (process.stdout.isTTY) console.error(ui.t.muted('  Put it in .env on both services, e.g. BILLING_SECRET=... and read it in white.config.js'));
    return;
  }
  if (action !== 'status') {
    console.log(USAGE);
    process.exit(action ? 1 : 0);
  }

  const { loadConfig, createMesh, ConfigError } = await import('../../index.js');
  try {
    const config = await loadConfig(root);
    if (!config.mesh) {
      console.error(`\n  ${ui.t.error(ui.sym.err)}  No "mesh" in white.config.js. See the README, section "Services".\n`);
      process.exit(1);
    }
    const mesh = createMesh(config, { config, root, log: silent, routes: [], cache: { wrap: (k, fn) => fn() }, onClose() {} });
    const results = await mesh.status();
    console.log(`\n  ${ui.t.bold(mesh.name)} ${ui.t.muted(`talks to ${results.length} service${results.length === 1 ? '' : 's'}`)}\n`);
    if (!results.length) console.log(`  ${ui.t.muted('No peers configured.')}\n`);

    const width = Math.max(0, ...results.map((r) => r.name.length));
    for (const r of results) {
      const icon = r.ok ? ui.t.success(ui.sym.ok) : ui.t.error(ui.sym.err);
      const detail = r.ok ? `${r.ms}ms${r.version ? `  white-js ${r.version}` : ''}` : r.error;
      console.log(`  ${icon}  ${r.name.padEnd(width)}  ${ui.t.muted(r.url)}  ${r.ok ? ui.t.muted(detail) : ui.t.error(detail)}`);
    }
    console.log('');
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`\n  ${ui.t.error(ui.sym.err)}  ${error.message}\n`);
    process.exit(1);
  }
}
