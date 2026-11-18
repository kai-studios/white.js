import { resolveConfig } from '../../src/core/config.js';
import { createApp } from '../../src/index.js';

// An app with logging off and a free port, built the way createApp is used in real projects
export const build = (config = {}, root = process.cwd()) => createApp(resolveConfig({ log: { level: 'silent' }, port: 0, host: '127.0.0.1', ...config }), root);
export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
