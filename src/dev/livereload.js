// Live reload for `white run dev`.
//
// - Changing a view or a file in public/ refreshes the browser. A changed .css file is swapped
//   in place, without a reload, so the page keeps its scroll position and state.
// - When the server restarts (code changes), the page reconnects and reloads itself.
//
// Dev only: nothing here is active in production.
import fs from 'node:fs';

const ENDPOINT = '/__white/reload';

const clientScript = `(() => {
  const source = new EventSource('${ENDPOINT}');
  let lost = false;
  source.addEventListener('css', () => {
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(link.href);
      if (url.origin !== location.origin) continue;
      url.searchParams.set('_r', Date.now());
      const next = link.cloneNode();
      next.href = url.href;
      next.onload = () => link.remove();
      link.after(next);
    }
  });
  source.addEventListener('reload', () => location.reload());
  source.onerror = () => { lost = true; };
  source.onopen = () => { if (lost) location.reload(); };
})();`;

export function liveReload(app, ctx) {
  const clients = new Set();
  const broadcast = (event) => {
    for (const res of clients) res.write(`event: ${event}\ndata: 1\n\n`);
  };

  app.get(ENDPOINT, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 400\n\n'); // reconnect fast after a server restart
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  // On shutdown, end the streams so the server can stop at once; browsers reconnect and reload
  ctx.onClose(() => {
    for (const res of clients) res.end();
    clients.clear();
  });

  // Add the client script to every HTML page
  app.use((req, res, next) => {
    const send = res.send;
    res.send = function patched(body) {
      if (typeof body === 'string' && /<\/body>/i.test(body)) {
        const type = String(res.get('Content-Type') ?? '');
        if (type ? type.includes('html') : /^\s*<(!doctype|html)/i.test(body)) {
          const tag = `<script nonce="${res.locals.nonce}">${clientScript}</script>`;
          body = body.replace(/<\/body>/i, () => tag + '</body>');
        }
      }
      return send.call(this, body);
    };
    next();
  });

  // One event per burst of file changes
  let timer;
  let kind = 'css';
  const changed = (file) => {
    if (!String(file ?? '').endsWith('.css')) kind = 'reload';
    clearTimeout(timer);
    timer = setTimeout(() => {
      broadcast(kind);
      kind = 'css';
    }, 40);
  };

  for (const dir of [ctx.abs(ctx.config.dirs.views), ctx.abs(ctx.config.dirs.public)]) {
    try {
      fs.watch(dir, { recursive: true }, (event, file) => changed(file)).unref();
    } catch {
      // the folder does not exist or cannot be watched: skip it
    }
  }

  return { broadcast };
}

export const reloadEndpoint = ENDPOINT;
