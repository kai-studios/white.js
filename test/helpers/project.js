import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Creates a throw-away project from { 'relative/path': 'content' | object }. Objects are written as JSON.
export function tmpProject(files = {}, { link = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'white-test-'));
  const write = (rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  // route files that import express need it resolvable: link this repo's node_modules
  if (link) fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  return {
    root,
    write,
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// A package in <root>/node_modules
export function installPackage(project, name, packageJson, files = {}) {
  project.write(`node_modules/${name}/package.json`, { name, version: '1.0.0', ...packageJson });
  for (const [rel, content] of Object.entries(files)) project.write(`node_modules/${name}/${rel}`, content);
}
