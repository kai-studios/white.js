// POST /api/internal/echo: only signed services reach it (mesh.protect)
export default (router) => {
  router.post('/', (req, res) => {
    res.json({ from: req.service.name, body: req.body, requestId: req.id });
  });
};
