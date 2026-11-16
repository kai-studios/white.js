import * as ui from '../../ui/index.js';

const paint = { GET: ui.t.success, POST: ui.t.warn, DELETE: ui.t.error };

// white routes: every route of the project, with the file it comes from
export async function routesCommand(root = process.cwd()) {
  process.env.NODE_ENV ??= 'development';
  process.env.LOG_LEVEL ??= 'warn';

  const { loadConfig, createApp } = await import('../../index.js');
  const { ctx } = await createApp(await loadConfig(root), root);

  const routes = [...ctx.routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  if (!routes.length) {
    console.log(`\n  ${ui.t.muted('No routes found. Create one with: white make route about')}\n`);
    return;
  }

  const methodWidth = Math.max(...routes.map((r) => r.method.length));
  const pathWidth = Math.max(...routes.map((r) => r.path.length));
  const lines = routes.map(
    (r) =>
      `  ${(paint[r.method] ?? ui.t.accent)(r.method.padEnd(methodWidth))}  ${ui.t.text(r.path.padEnd(pathWidth))}  ${ui.t.muted(r.file)}`,
  );
  console.log(`\n${lines.join('\n')}\n\n  ${ui.t.muted(`${routes.length} route${routes.length === 1 ? '' : 's'}`)}\n`);
  return routes;
}
