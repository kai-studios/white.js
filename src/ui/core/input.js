import readline from 'node:readline';
import process from 'node:process';

// Subscribes to key presses in raw mode. Returns a function that restores the terminal.
// onKey(str, key) receives readline's key objects: { name, ctrl, meta, shift, sequence }.
export function readKeys(onKey) {
  const stdin = process.stdin;
  readline.emitKeypressEvents(stdin);
  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode?.(true);
  stdin.resume();

  const handler = (str, key) => onKey(str, key ?? {});
  stdin.on('keypress', handler);

  return () => {
    stdin.off('keypress', handler);
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
  };
}

// Thrown by prompts when the user presses Ctrl+C or Esc
export class CancelError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelError';
  }
}
