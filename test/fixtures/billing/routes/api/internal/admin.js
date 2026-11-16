export default (router, ctx) => {
  router.get('/', ctx.mesh.auth({ allow: ['admin'] }), (req, res) => res.json({ secret: true, by: req.service.name }));
};
