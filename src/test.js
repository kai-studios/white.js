// Test helper: import { createTestClient } from 'white-js/test'
//
//   const client = await createTestClient({ dirs: { routes: 'test/fixtures/routes' } });
//   const res = await client.get('/api/status');
//   assert.equal(res.status, 200);
//   assert.deepEqual(res.json, { ok: true });
//   await client.close();
//
// The app runs on a free port with logging off, so tests do not collide or print. Cookies are
// kept between calls, so a login followed by a protected request works as in a browser.
import { createApp } from './core/app.js';
import { resolveConfig } from './core/config.js';

export async function createTestClient(config = {}, { root = process.cwd() } = {}) {
  const resolved = resolveConfig({ ...config, log: { level: 'silent', ...config.log } });
  const { app, ctx } = await createApp(resolved, root);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();

  async function request(method, path, { json, form, body, headers = {}, redirect = 'manual' } = {}) {
    const init = { method, redirect, headers: { ...headers } };
    if (jar.size) init.headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (form) {
      init.headers['content-type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      init.body = body;
    }

    const res = await fetch(base + path, init);
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      if (/;\s*max-age=0\b|;\s*expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
      else jar.set(name, pair.slice(eq + 1).trim());
    }

    const text = await res.text();
    let parsed;
    if ((res.headers.get('content-type') ?? '').includes('json')) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON after all
      }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, text, json: parsed, location: res.headers.get('location') };
  }

  return {
    app,
    ctx,
    url: base,
    cookies: jar,
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, options) => request('POST', path, options),
    put: (path, options) => request('PUT', path, options),
    patch: (path, options) => request('PATCH', path, options),
    delete: (path, options) => request('DELETE', path, options),
    close: () => new Promise((resolve) => (server.closeAllConnections?.(), server.close(resolve))),
  };
}
