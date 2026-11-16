export default (router) => {
  router.get('/', (req, res) => res.json({ public: true }));
};
