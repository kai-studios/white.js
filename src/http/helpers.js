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
