// One generation per adapter, so either can be deleted when it is dropped from "supported".
const adapters = {
  '2.0': { describe: () => ({ generation: '2.0', field: 'tags' }) },
  '3.0': { describe: () => ({ generation: '3.0', field: 'labels' }) },
};

export default function whiteAuth(app, ctx) {
  // Ask once, at start-up. The answer is fixed for the life of the process: the app chose it in
  // white.protocols.json, or it is this library's "required" generation.
  const generation = ctx.protocols.for('white-auth-example').version('meta');
  const adapter = adapters[generation];
  if (!adapter) throw new Error(`white-auth-example does not support meta@${generation}`); // never guess

  ctx.log.info(`white-auth-example uses meta@${generation}`);
  app.get('/auth/whoami', (req, res) => res.json(adapter.describe()));
}
