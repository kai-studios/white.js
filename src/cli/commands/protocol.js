import fs from 'node:fs';
import * as ui from '../../ui/index.js';
import { loadConfig, resolveConfig } from '../../core/config.js';
import { loadProtocolState, parseRef } from '../../protocols/index.js';
import { integrityOf } from '../../migrations/diff.js';
import { WhiteError } from '../../core/white-error.js';

const STATUS_COLOR = { current: ui.t.success, supported: ui.t.text, deprecated: ui.t.warn, blocked: ui.t.error, removed: ui.t.error };
const status = (s) => (STATUS_COLOR[s] ?? ui.t.text)(s.toUpperCase().padEnd(10));

async function state(root) {
  let config;
  try {
    config = await loadConfig(root);
  } catch (error) {
    if (!(error instanceof WhiteError)) throw error;
    console.error(`  ${ui.t.warn('Could not load white.config.js')} (${error.message.split('\n')[0]}); using defaults.\n`);
    config = resolveConfig({});
  }
  return loadProtocolState(config, root);
}

function list({ registry, report }, json) {
  if (json) return console.log(JSON.stringify(registry.toJSON(), null, 2));
  console.log(`\n  ${ui.t.bold('Protocols')} ${ui.t.muted(`(registry ${registry.fingerprint()})`)}\n`);
  for (const name of registry.names()) {
    console.log(`  ${ui.t.accent(name)}`);
    for (const m of registry.versions(name)) {
      const users = report.users.filter((u) => u.protocol === name && u.version === m.version).map((u) => u.subject);
      const impl = registry.hasImplementation(name, m.version) ? '' : ui.t.error('  no implementation');
      console.log(`    ${`${name}@${m.version}`.padEnd(14)} ${status(m.status)}${users.length ? ui.t.muted(`  used by ${users.join(', ')}`) : ''}${impl}`);
    }
    console.log('');
  }
}

function info({ registry, report }, target, json) {
  const names = registry.names();
  let refs;
  if (target.includes('@')) {
    const { name, version } = parseRef(target);
    if (!registry.has(name, version)) throw new WhiteError(`${target} is not registered`, { code: 'PROTOCOL_UNKNOWN', hint: `Known versions of ${name}: ${registry.versions(name).map((m) => m.version).join(', ') || 'none'}` });
    refs = [registry.get(name, version)];
  } else {
    if (!registry.has(target)) throw new WhiteError(`Unknown protocol "${target}"`, { code: 'PROTOCOL_UNKNOWN', hint: `Known protocols: ${names.join(', ')}` });
    refs = registry.versions(target);
  }
  if (json) return console.log(JSON.stringify(refs.map((m) => ({ ...m, source: registry.sourceOf(m.name, m.version), implementations: registry.implementations(m.name, m.version) })), null, 2));

  console.log('');
  for (const m of refs) {
    const row = (k, v) => v !== undefined && console.log(`    ${ui.t.muted(k.padEnd(16))}${v}`);
    console.log(`  ${ui.t.bold(`${m.name}@${m.version}`)}  ${status(m.status)}`);
    row('defined by', registry.sourceOf(m.name, m.version));
    row('White.js', m.compatibility.white ?? 'any');
    row('interoperates', m.compatibility.protocols.length ? m.compatibility.protocols.join(', ') : 'none declared');
    row('replaces', m.replaces);
    row('generations', m.coexistence === 'single' ? 'one per process' : 'may coexist');
    const impls = registry.implementations(m.name, m.version);
    row('implemented by', impls.length ? impls.map((i) => (i.package ? `${i.package}@${i.packageVersion}` : i.source)).join(', ') : ui.t.error('nobody'));
    if (m.migration) row('migration', `${m.migration.from} → ${m.migration.to}, ${m.migration.strategy}${m.migration.id ? ` (${m.migration.id})` : ''}${m.migration.integrity ? '' : ui.t.warn('  unverified: no integrity')}`);
    if (m.deprecation) row('deprecated', [m.deprecation.since && `since ${m.deprecation.since}`, m.deprecation.removeIn && `removal in ${m.deprecation.removeIn}`, m.deprecation.message].filter(Boolean).join(', '));
    if (m.advisory) row('advisory', `${m.advisory.id} (${m.advisory.severity ?? 'unrated'}): ${m.advisory.summary}`);
    if (m.reason) row('reason', m.reason);
    const users = report.users.filter((u) => u.protocol === m.name && u.version === m.version);
    row('used by', users.length ? users.map((u) => u.subject).join(', ') : 'nothing in this project');
    console.log('');
  }
}

export async function protocolCommand(args, root = process.cwd()) {
  const json = args.includes('--json');
  const [sub, target] = args.filter((a) => !a.startsWith('--'));
  try {
    if (sub === 'integrity') {
      if (!target) throw new WhiteError('Usage: white protocol integrity <migration-file>', { code: 'USAGE' });
      // the value to put into "migration.integrity" of the protocol manifest
      console.log(integrityOf(fs.readFileSync(target)));
      return process.exit(0);
    }
    if (sub === 'list') list(await state(root), json);
    else if (sub === 'info' && target) info(await state(root), target, json);
    else {
      console.error(`\n  Usage:\n    white protocol list [--json]\n    white protocol info <name | name@version> [--json]\n    white protocol integrity <migration-file>\n`);
      return process.exit(sub ? 1 : 0);
    }
  } catch (error) {
    if (!(error instanceof WhiteError) && !(error instanceof TypeError)) throw error;
    console.error(`\n  ${ui.t.error(ui.sym.err)}  ${error.message}${error.hint ? `\n     ${ui.t.muted(error.hint)}` : ''}\n`);
    return process.exit(1);
  }
  process.exit(0);
}
