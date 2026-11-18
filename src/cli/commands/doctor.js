import * as ui from '../../ui/index.js';
import { diagnose } from '../../doctor/index.js';

export { runChecks } from '../../doctor/index.js';

const ICON = {
  ok: () => ui.t.success(ui.sym.ok),
  info: () => ui.t.muted('i'),
  warning: () => ui.t.warn(ui.sym.fail),
  error: () => ui.t.error(ui.sym.err),
  critical: () => ui.t.error('!!'),
};
const STATUS_COLOR = { OK: ui.t.success, WARNING: ui.t.warn, ERROR: ui.t.error, CRITICAL: ui.t.error };
const LABEL = (s) => s.toUpperCase();
const rule = (title) => `${ui.t.bold(title)}\n  ${ui.t.muted((ui.caps.unicode ? '─' : '-').repeat(36))}`;

// The protocol part, in the layout of the specification
export function renderProtocols(report, registry) {
  const lines = [];
  const protocols = [...new Set(report.users.map((u) => u.protocol))].sort();
  for (const name of protocols) {
    const users = report.users.filter((u) => u.protocol === name);
    lines.push('', `  ${ui.t.bold(name.toUpperCase())}`);
    for (const m of registry.versions(name)) lines.push(`    ${`${name}@${m.version}`.padEnd(14)}${LABEL(m.status)}`);
    const legacy = users.filter((u) => u.kind === 'library' && registry.current(name) && registry.current(name).version !== u.version);
    lines.push('', `  Detected:`);
    if (legacy.length) lines.push(`    ${legacy.length} librar${legacy.length === 1 ? 'y uses a' : 'ies use a'} legacy protocol.`, '');
    const width = Math.max(...users.map((u) => u.subject.length)) + 2;
    for (const u of users) lines.push(`    ${u.subject.padEnd(width)}${name}@${u.version}${u.explicit ? ui.t.muted('  (selected in white.protocols.json)') : ''}`);
  }
  const recs = report.recommendations;
  if (recs.length) {
    lines.push('', '  Recommendations:');
    const width = Math.max(...recs.map((r) => r.subject.length)) + 2;
    for (const r of recs) {
      lines.push(`    ${r.subject.padEnd(width)}${ui.caps.unicode ? '→' : '->'} ${r.protocol}@${r.to}${r.action === 'update-library' ? ui.t.muted('  (needs a release of the library that supports it)') : ''}`);
    }
    lines.push('', '  Migration available:', `    ${report.migrations.automatic} automatic`, `    ${report.migrations.manual} manual`);
  }
  return lines;
}

export async function doctorCommand(args = [], root = process.cwd()) {
  const json = args.includes('--json');
  const result = await diagnose(root, { deep: args.includes('--deep') });
  const strict = args.includes('--strict') && result.summary.warning > 0 && result.exitCode === 0;
  const exitCode = strict ? 1 : result.exitCode;

  if (json) {
    const { registry, ...rest } = result;
    console.log(JSON.stringify({ ...rest, exitCode, registry: registry?.toJSON() }, null, 2));
    process.exit(exitCode);
  }

  console.log(`\n  ${ui.t.bold('White.js Doctor')}\n`);
  for (const section of result.sections) {
    console.log(`  ${rule(section.title)}`);
    for (const i of section.items) {
      console.log(`  ${ICON[i.severity]()}  ${i.title}${i.detail ? ui.t.muted(`  ${i.detail}`) : ''}`);
    }
    if (section.title === 'Protocol Compatibility' && result.protocols?.users.length) console.log(renderProtocols(result.protocols, result.registry).join('\n'));
    console.log('');
  }
  const { summary } = result;
  const parts = [summary.critical && `${summary.critical} critical`, summary.error && `${summary.error} error${summary.error === 1 ? '' : 's'}`, summary.warning && `${summary.warning} warning${summary.warning === 1 ? '' : 's'}`].filter(Boolean);
  console.log(`  Status: ${(STATUS_COLOR[result.status] ?? ((s) => s))(strict ? 'WARNING (strict)' : result.status)}${parts.length ? ui.t.muted(`  ${parts.join(', ')}`) : ''}\n`);
  process.exit(exitCode);
}
