import { Eta } from 'eta';

// Connects Eta to Express res.render()
export function etaEngine(viewsDir, { cache }) {
  const eta = new Eta({ views: viewsDir, cache, autoEscape: true });
  return (file, data, cb) => {
    // Express passes an absolute path; Eta expects a name relative to views
    const { settings, _locals, cache: _c, ...locals } = data;
    eta.renderAsync(file.slice(viewsDir.length).replace(/\\/g, '/'), locals).then(
      (html) => cb(null, html),
      cb,
    );
  };
}
