#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const examples = {
  site: 'https://github.com/kai-studios/white-generator.git',
};

function fail(message) {
  console.error(`White.js: ${message}`);
  process.exit(1);
}

export function installExample(args) {
  const [specifier, ...extra] = args;
  if (!specifier || extra.length) {
    console.log('Usage: white install example:<name>');
    process.exit(specifier ? 1 : 0);
  }

  const match = /^example:([a-z0-9][a-z0-9-]*)$/.exec(specifier);
  if (!match) fail(`Invalid example: ${specifier}`);

  const name = match[1];
  const repository = examples[name];
  if (!repository) {
    fail(`Unknown example "${name}". Available examples: ${Object.keys(examples).join(', ')}`);
  }

  const target = path.resolve(process.cwd(), name);
  if (fs.existsSync(target)) fail(`Target already exists: ${target}`);

  const staging = fs.mkdtempSync(path.join(process.cwd(), `.white-install-${name}-`));
  const checkout = path.join(staging, 'repo');
  console.log(`Installing example "${name}" from ${repository} ...`);

  const result = spawnSync('git', ['clone', '--depth', '1', repository, checkout], { stdio: 'inherit' });
  if (result.error) {
    fs.rmSync(staging, { recursive: true, force: true });
    fail(`Could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    fail(`Could not clone example "${name}" (git exited with ${result.status ?? 'no status'}).`);
  }

  fs.rmSync(path.join(checkout, '.git'), { recursive: true, force: true });
  fs.renameSync(checkout, target);
  fs.rmSync(staging, { recursive: true, force: true });
  console.log(`Example installed in ${target}. Run "cd ${name}" and "npm install" to get started.`);
}
