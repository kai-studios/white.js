// Command router. Each command is imported on demand, so `white --help` and
// `white install` start without loading Express and the rest of the framework.
import { version } from '../core/meta.js';

const commands = {
  run: async (args) => (await import('./commands/run.js')).run(args),
  install: async (args) => (await import('./commands/install.js')).installExample(args),
  plugin: async (args) => (await import('./commands/plugin.js')).pluginCommand(args),
  routes: async () => (await import('./commands/routes.js')).routesCommand().then(() => process.exit(0)),
  make: async (args) => (await import('./commands/make.js')).makeCommand(args),
  doctor: async () => (await import('./commands/doctor.js')).doctorCommand(),
};

async function help(code) {
  const { t, sym } = await import('../ui/index.js');
  const row = (cmd, text) => `  ${t.accent(cmd.padEnd(34))}${t.muted(text)}`;
  const lines = [
    '',
    `  ${t.bold('White.js')} ${t.muted(`v${version}`)}`,
    '',
    `  ${t.muted('Usage')}  white <command>`,
    '',
    row('white run', 'start the site'),
    row('white run dev', 'start with restart on changes'),
    row('white install example:<name>', 'create a project from an example'),
    row('white plugin add <name...>', 'install and enable plugins'),
    row('white plugin remove <name...>', 'remove plugins'),
    row('white routes', 'list routes and the files they come from'),
    row('white make route <path> [--api]', 'create a route (and its view)'),
    row('white make plugin <name>', 'create and register a local plugin'),
    row('white doctor', 'check the project for problems'),
    '',
    `  ${t.muted(sym.arrow)} ${t.muted('white install example:site my-site -y')}`,
    '',
  ];
  (code ? console.error : console.log)(lines.join('\n'));
  process.exit(code);
}

export async function main([command, ...args]) {
  if (command === '-v' || command === '--version') return console.log(version);
  if (!command || command === 'help' || command === '-h' || command === '--help') return help(0);
  if (!(command in commands)) return help(1);

  try {
    await commands[command](args);
  } catch (error) {
    const { CancelError } = await import('../ui/index.js');
    if (error instanceof CancelError) {
      const { t, sym } = await import('../ui/index.js');
      console.log(`  ${t.muted(sym.outro)}  ${t.muted('Cancelled')}\n`);
      process.exit(130);
    }
    throw error;
  }
}
