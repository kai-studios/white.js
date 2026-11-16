// White.js terminal UI. Zero dependencies; everything is drawn with ANSI sequences.
//
//   import * as ui from './ui/index.js';
//   await ui.intro('Create a project');
//   const name = await ui.text({ message: 'Name', placeholder: 'site' });
//   await ui.tasks('Setting up', [{ title: 'Download', run: async ({ progress }) => progress(1) }]);
//   ui.outro('Done');
export { caps } from './core/ansi.js';
export { Live } from './core/live.js';
export { CancelError } from './core/input.js';
export { t, sym } from './core/theme.js';
export { text } from './prompts/text.js';
export { select } from './prompts/select.js';
export { confirm } from './prompts/confirm.js';
export { tasks } from './tasks.js';
export { intro, outro, log, note } from './session.js';
export { spinner } from './components/spinner.js';
export { progressBar } from './components/progress.js';
export { gradient } from './components/gradient.js';
export { logoLines, playLogo } from './components/logo.js';
