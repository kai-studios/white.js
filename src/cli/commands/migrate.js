import fs from 'node:fs';
import * as ui from '../../ui/index.js';
import { loadConfig, resolveConfig } from '../../core/config.js';
import { WhiteError } from '../../core/white-error.js';
import { createMigrationEngine } from '../../migrations/engine.js';

const arrow = () => (ui.caps.unicode ? '→' : '->');
const STATE = { pending: ui.t.warn('to migrate'), already: ui.t.success('up to date'), blocked: ui.t.error('blocked'), applied: ui.t.success('applied'), manual: ui.t.warn('manual') };

function parse(args) {
  const flags = { analyze: false, manual: false, yes: false, diff: false, recover: false, json: false, allowDestructive: false, out: undefined };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--analyze' || a === '--dry-run') flags.analyze = true;
    else if (a === '--manual') flags.manual = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--diff') flags.diff = true;
    else if (a === '--recover') flags.recover = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--allow-destructive') flags.allowDestructive = true;
    else if (a === '--out') flags.out = args[++i];
    else if (a.startsWith('--')) throw new WhiteError(`Unknown option ${a}`, { code: 'USAGE', hint: 'Options: --analyze, --manual [--out file], --diff, --yes, --recover, --allow-destructive, --json' });
    else positional.push(a);
  }
  if (flags.analyze && flags.manual) throw new WhiteError('Use either --analyze or --manual, not both', { code: 'USAGE' });
  if (positional.length > 1) throw new WhiteError('Give one target, for example: white migrate meta@3.0', { code: 'USAGE' });
  return { flags, target: positional[0] };
}

function printPlan(plan, flags) {
  const out = [''];
  out.push(`  ${ui.t.bold('Migration plan')}${plan.targets.length ? `  ${ui.t.accent(plan.targets.join(', '))}` : ''}${plan.mandatory ? ui.t.muted('  (required: blocked or removed versions)') : ''}`, '');
  for (const n of plan.notes) out.push(`  ${ui.t.muted(n)}`);

  if (plan.users.length) {
    out.push(`  ${ui.t.muted('Uses')}`);
    const width = Math.max(...plan.users.map((u) => u.subject.length)) + 2;
    for (const u of plan.users) out.push(`    ${u.subject.padEnd(width)}${u.protocol}@${u.from}${u.from === u.to ? '' : ` ${arrow()} ${u.to}`}  ${STATE[u.state] ?? ''}`);
    out.push('');
  }
  if (plan.steps.length) {
    out.push(`  ${ui.t.muted('Migrations')}`);
    for (const s of plan.steps) out.push(`    ${s.id}  ${ui.t.muted(`${s.protocol}@${s.from} ${arrow()} ${s.to}, ${s.strategy}, from ${s.origin}`)}  ${STATE[s.state] ?? ''}${s.reason ? `\n      ${ui.t.error(s.reason)}` : ''}`);
    out.push('');
  }
  if (plan.files.length) {
    out.push(`  ${ui.t.muted('Files that change')}`);
    for (const f of plan.files) out.push(`    ${f.kind === 'create' ? ui.t.success('create') : ui.t.warn('edit  ')} ${f.file}  ${ui.t.muted(`+${f.stats.added} -${f.stats.removed}`)}${f.destructive ? ui.t.error('  removes most of the file') : ''}`);
    out.push('');
    if (flags.diff) for (const f of plan.files) out.push(...f.diff.split('\n').map((l) => `    ${l[0] === '+' && !l.startsWith('+++') ? ui.t.success(l) : l[0] === '-' && !l.startsWith('---') ? ui.t.error(l) : ui.t.muted(l)}`), '');
  }
  if (plan.manual.length) {
    out.push(`  ${ui.t.warn('Needs you')}  ${ui.t.muted('(cannot be automated)')}`);
    for (const m of plan.manual) out.push(`    ${m.file ? `${m.file}: ` : ''}${m.message}${m.hint ? ui.t.muted(`\n      ${m.hint}`) : ''}`);
    out.push('');
  }
  if (plan.blockers.length) {
    out.push(`  ${ui.t.error('Cannot migrate')}`);
    for (const b of plan.blockers) out.push(`    ${ui.sym.err} ${b.message}`);
    out.push('');
  }
  console.log(out.join('\n'));
}

export async function migrateCommand(args, root = process.cwd()) {
  const { flags, target } = parse(args);
  let config;
  try {
    config = await loadConfig(root);
  } catch (error) {
    if (!(error instanceof WhiteError)) throw error;
    config = resolveConfig({});
  }
  const engine = createMigrationEngine({ root, config });

  try {
    if (flags.recover) {
      const { recovered } = await engine.recover();
      console.log(recovered.length ? `\n  ${ui.t.success(ui.sym.ok)}  Restored ${recovered.length} interrupted run${recovered.length === 1 ? '' : 's'}: ${recovered.map((r) => r.runId).join(', ')}\n` : `\n  Nothing to recover.\n`);
      return process.exit(0);
    }

    const plan = await engine.plan({ target });

    if (flags.json) {
      const { files, ...rest } = plan;
      console.log(JSON.stringify({ ...rest, files: files.map(({ after, ...f }) => f), mode: flags.manual ? 'manual' : flags.analyze ? 'analysis' : 'automatic' }, null, 2));
      return process.exit(plan.blockers.length ? 1 : 0);
    }

    // 1. Analysis: describe, change nothing
    if (flags.analyze) {
      printPlan(plan, { ...flags, diff: true });
      console.log(`  ${ui.t.muted('Analysis only: no file was changed.')}\n`);
      return process.exit(plan.blockers.length ? 1 : 0);
    }

    // 2. Manual: instructions for the developer
    if (flags.manual) {
      const guide = engine.manualGuide(plan);
      if (flags.out) {
        fs.writeFileSync(flags.out, guide);
        console.log(`\n  ${ui.t.success(ui.sym.ok)}  Instructions written to ${flags.out}\n`);
      } else console.log('\n' + guide);
      return process.exit(plan.blockers.length ? 1 : 0);
    }

    // 3. Automatic
    printPlan(plan, flags);
    if (plan.blockers.length) return process.exit(1);
    if (plan.upToDate) {
      console.log(`  ${ui.t.success(ui.sym.ok)}  Nothing to migrate.\n`);
      return process.exit(0);
    }
    if (!plan.canApply) {
      console.log(`  ${ui.t.muted('There are no automatic changes. Follow the steps above, or run again with --manual for a guide.')}\n`);
      return process.exit(0);
    }

    if (!flags.yes) {
      if (!ui.caps.interactive) {
        console.error(`  ${ui.t.error(ui.sym.err)}  Not running in a terminal: nothing was changed. Re-run with --yes to apply, or --analyze to only look.\n`);
        return process.exit(1);
      }
      const go = await ui.confirm({ message: `Apply ${plan.files.length} change${plan.files.length === 1 ? '' : 's'}? Originals are backed up and restored if anything fails.`, initial: false });
      if (!go) {
        console.log(`  ${ui.t.muted('Cancelled: nothing was changed.')}\n`);
        return process.exit(0);
      }
    }

    const result = await engine.apply(plan, { allowDestructive: flags.allowDestructive, onStage: (s) => console.log(`  ${ui.t.muted(`${s}…`)}`) });
    console.log(`\n  ${ui.t.success(ui.sym.ok)}  Migrated ${result.steps.join(', ')}`);
    console.log(`     ${ui.t.muted(`${result.files.length} file${result.files.length === 1 ? '' : 's'} changed. Backup and journal: .white/migrations/${result.runId}`)}`);
    if (result.manual.length) console.log(`     ${ui.t.warn(`${result.manual.length} step${result.manual.length === 1 ? '' : 's'} still need${result.manual.length === 1 ? 's' : ''} you (listed above). Run "white migrate ${target ?? ''}" again to see what is left.`)}`);
    console.log(`     ${ui.t.muted('Review with git diff, run your tests, then commit white.protocols.json and white.migrations.json.')}\n`);
    process.exit(0);
  } catch (error) {
    if (!(error instanceof WhiteError || error instanceof TypeError)) throw error;
    console.error(`\n  ${ui.t.error(ui.sym.err)}  ${error.message}${error.hint ? `\n     ${ui.t.muted(error.hint)}` : ''}\n`);
    process.exit(1);
  }
}
