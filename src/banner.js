import fs from 'node:fs';

const LOGO = [
  '██╗    ██╗██╗  ██╗██╗████████╗███████╗        ██╗███████╗',
  '██║    ██║██║  ██║██║╚══██╔══╝██╔════╝        ██║██╔════╝',
  '██║ █╗ ██║███████║██║   ██║   █████╗          ██║███████╗',
  '██║███╗██║██╔══██║██║   ██║   ██╔══╝     ██   ██║╚════██║',
  '╚███╔███╔╝██║  ██║██║   ██║   ███████╗██╗╚█████╔╝███████║',
  ' ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝   ╚═╝   ╚══════╝╚═╝ ╚════╝ ╚══════╝',
];

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Colors are disabled for non-TTY output and when NO_COLOR is set
const useColor =
  'FORCE_COLOR' in process.env || (process.stdout.isTTY && !('NO_COLOR' in process.env));
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

const c = {
  logo: paint('1;97'), // bold bright white
  dim: paint('90'),
  path: paint('36'), // cyan
  link: paint('4;95'), // underlined magenta
  GET: paint('32'),
  POST: paint('33'),
  PUT: paint('34'),
  PATCH: paint('34'),
  DELETE: paint('31'),
};

export function printBanner({ port, dev, routes }) {
  const out = [''];
  for (const line of LOGO) out.push('  ' + c.logo(line));
  out.push('  ' + c.dim(`v${version}  ·  ${dev ? 'development' : 'production'}`), '');

  if (dev && routes.length) {
    const sorted = [...routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    const width = Math.max(...sorted.map((r) => r.method.length));
    for (const r of sorted) {
      const color = c[r.method] ?? c.dim;
      out.push('  ' + color(r.method.padEnd(width)) + '  ' + c.path(r.path));
    }
    out.push('');
  }

  out.push('  ' + c.dim('Local:') + '  ' + c.link(`http://localhost:${port}`), '');
  console.log(out.join('\n'));
}
