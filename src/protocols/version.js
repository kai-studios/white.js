import semver from 'semver';

// Protocol versions are "MAJOR.MINOR" and are NOT semver of a library (see docs/protocols.md).
//   MAJOR  a new generation. Peers of different generations are not assumed to understand each other.
//   MINOR  an additive change inside a generation. It must keep working with the previous minors,
//          and says so explicitly in its manifest (compatibility.protocols).
// There is no patch level: a bug fix in an implementation is a library release, not a protocol one.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const isProtocolVersion = (v) => typeof v === 'string' && VERSION.test(v);

export function parseProtocolVersion(v) {
  if (!isProtocolVersion(v)) throw new TypeError(`Invalid protocol version ${JSON.stringify(v)}: expected MAJOR.MINOR such as "3.0"`);
  const [major, minor] = v.split('.').map(Number);
  return { major, minor };
}

export function compareProtocolVersions(a, b) {
  const [x, y] = [parseProtocolVersion(a), parseProtocolVersion(b)];
  return x.major - y.major || x.minor - y.minor;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
export const isProtocolName = (n) => typeof n === 'string' && NAME.test(n);

// "meta@3.0" -> { name: 'meta', version: '3.0', id: 'meta@3.0' }; throws on anything else
export function parseRef(ref) {
  const [name, version, ...rest] = String(ref).split('@');
  if (rest.length || !isProtocolName(name) || !isProtocolVersion(version)) throw new TypeError(`Invalid protocol reference ${JSON.stringify(ref)}: expected name@MAJOR.MINOR such as "meta@3.0"`);
  return { name, version, id: `${name}@${version}` };
}

export const tryParseRef = (ref) => {
  try {
    return parseRef(ref);
  } catch {
    return null;
  }
};

// Framework and library versions are semver; ranges follow the npm syntax (">=0.3.0", "^2.4").
// Pre-releases of the framework (0.4.0-beta.1) satisfy a range that their release would.
export const isRange = (r) => typeof r === 'string' && semver.validRange(r) !== null;
export const satisfies = (version, range) => semver.satisfies(version, range, { includePrerelease: true });
export const isSemver = (v) => semver.valid(v) !== null;
