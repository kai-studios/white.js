import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

// Serializes data for use inside <script>. Output is raw: <%~ it.w.json(data) %>
export function json(data) {
  return (JSON.stringify(data) ?? 'null').replace(
    /[<>&\u2028\u2029]/g,
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

// Returns the URL if it is safe for href/src, otherwise "#" (blocks javascript: and friends)
export function url(value) {
  const clean = String(value ?? '').replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(clean);
  if (scheme) return SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? String(value).trim() : '#';
  return String(value ?? '').trim();
}

// Adds a content hash to a public file URL so browsers refetch it after changes:
// /css/style.css -> /css/style.css?v=3f2a9c1d7e
export function createAsset(publicDir, dev) {
  const cache = new Map();
  return (urlPath) => {
    const [clean] = String(urlPath).split('?');
    const file = path.join(publicDir, clean);
    if (!file.startsWith(publicDir + path.sep)) return urlPath;
    try {
      let version;
      if (dev) {
        version = Math.floor(fs.statSync(file).mtimeMs).toString(36);
      } else {
        version = cache.get(file);
        if (!version) {
          version = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
          cache.set(file, version);
        }
      }
      return `${clean}?v=${version}`;
    } catch {
      return urlPath; // file not found: return unchanged
    }
  };
}

// Helpers for templates, available as it.w.* (see createApp). `locale` comes from config.locale.
export function createHelpers(locale = 'en') {
  return {
    // it.w.date(post.date)  ->  "November 16, 2026";  it.w.date(d, { dateStyle: 'short' })
    date(value, options = { dateStyle: 'long' }) {
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(locale, options).format(date);
    },

    // it.w.number(1234.5)  ->  "1,234.5";  it.w.number(0.42, { style: 'percent' })
    number(value, options) {
      const n = Number(value);
      return Number.isFinite(n) ? new Intl.NumberFormat(locale, options).format(n) : '';
    },

    // Cuts text at a word boundary: it.w.truncate(post.body, 140)
    truncate(text, length = 120, tail = '\u2026') {
      const value = String(text ?? '').trim();
      if (value.length <= length) return value;
      const cut = value.slice(0, length);
      const space = cut.lastIndexOf(' ');
      return (space > length * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '') + tail;
    },

    // class="<%= it.w.classes('btn', { 'btn--big': big }, error && 'has-error') %>"
    classes(...parts) {
      return parts
        .flatMap((part) =>
          part && typeof part === 'object' ? Object.entries(part).filter(([, on]) => on).map(([name]) => name) : [part],
        )
        .filter((part) => typeof part === 'string' && part)
        .join(' ');
    },

    // Is this nav link the current page?  it.w.active(it.path, '/blog')
    // "/blog" matches /blog and /blog/post; "/" and { exact: true } match only themselves.
    active(current, href, { exact = false } = {}) {
      const path = String(current ?? '').split(/[?#]/)[0];
      const target = String(href ?? '').split(/[?#]/)[0];
      if (exact || target === '/') return path === target;
      return path === target || path.startsWith(target.replace(/\/$/, '') + '/');
    },

    // it.w.slug('Hello, World!')  ->  "hello-world" (keeps letters of any alphabet)
    slug(text) {
      return String(text ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
    },
  };
}
