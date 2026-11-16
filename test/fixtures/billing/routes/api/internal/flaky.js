// Fails twice with 503, then works: for retry tests
let calls = 0;
export default (router) => {
  router.get('/', (req, res) => {
    calls += 1;
    if (calls <= 2) return res.status(503).json({ error: 'busy' });
    res.json({ ok: true, calls });
  });
  router.post('/reset', (req, res) => {
    calls = 0;
    res.json({ ok: true });
  });
};
