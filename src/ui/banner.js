// Startup banner of a running site. Static (no animation) so the server starts instantly.
import { caps, color, underline } from './core/ansi.js';
import { t, MARGIN } from './core/theme.js';
import { logoLines } from './components/logo.js';
import { version } from '../core/meta.js';

const methodColor = {
  GET: t.success,
  POST: t.warn,
  PUT: color('#93c5fd'),
  PATCH: color('#93c5fd'),
  DELETE: t.error,
};

const link = (url) => (caps.depth ? underline(t.accent(url)) : url);

export function printBanner({ port, dev, routes }) {
  const out = ['', ...logoLines(), `${MARGIN}${t.muted(`v${version}  ·  ${dev ? 'development' : 'production'}`)}`, ''];

  if (dev && routes.length) {
    const sorted = [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    const width = Math.max(...sorted.map((r) => r.method.length));
    for (const r of sorted) {
      const paint = methodColor[r.method] ?? t.muted;
      out.push(`${MARGIN}${paint(r.method.padEnd(width))}  ${t.accent(r.path)}`);
    }
    out.push('');
  }

  out.push(`${MARGIN}${t.muted('Local:')}  ${link(`http://localhost:${port}`)}`, '');
  console.log(out.join('\n'));
}
