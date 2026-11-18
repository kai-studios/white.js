import { createApp, resolveConfig } from '../../../src/index.js';

const mode = process.argv[2];
const config = resolveConfig({
  port: 0,
  host: '127.0.0.1',
  shutdownTimeout: 300,
  log: { level: 'silent' },
  plugins: [
    (app, ctx) =>
      ctx.onClose(() => {
        if (mode === 'hang') return new Promise(() => {});
        console.log('CLOSED');
      }),
  ],
});
const { start } = await createApp(config);
await start();
console.log('READY');
