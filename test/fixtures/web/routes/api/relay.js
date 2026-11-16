// POST /api/relay: forwards the body to billing through the mesh
export default (router, ctx) => {
  router.post('/', async (req, res) => {
    const upstream = await ctx.mesh.peer('billing').json('POST', '/api/internal/echo', { json: req.body });
    res.json({ upstream, requestId: req.id });
  });
  router.get('/flaky', async (req, res) => {
    const upstream = await ctx.mesh.peer('billing').json('GET', '/api/internal/flaky');
    res.json(upstream);
  });
};
