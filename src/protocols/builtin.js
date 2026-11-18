// Protocols that White.js itself implements. They describe contracts that exist in this code base:
//
//   mesh@1.0    signed service-to-service calls, events and discovery (src/mesh): the WHITE1
//               signature scheme, the x-white-* headers and the /_white/* endpoints.
//   plugin@1.0  the plugin contract: a module whose default export is function(app, ctx, options).
//
// Other protocols (for example the "meta" protocol used as an example in the documentation) are
// introduced by libraries through "white.defines" in their package.json.
export const BUILTIN_PROTOCOLS = Object.freeze([
  {
    name: 'mesh',
    version: '1.0',
    status: 'current',
    compatibility: { white: '>=0.3.0' },
    implementation: 'builtin',
  },
  {
    name: 'plugin',
    version: '1.0',
    status: 'current',
    compatibility: { white: '>=0.3.0' },
    implementation: 'builtin',
  },
]);
