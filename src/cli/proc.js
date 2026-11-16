import { spawn } from 'node:child_process';

// Runs a command with captured output; every output line goes to onLine().
// On Windows npm/pnpm are .cmd files and need a shell; arguments here are never user text.
// Rejects with an Error whose .output holds everything the command printed.
export function exec(command, args, { cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = windows
      ? spawn([command, ...args].join(' '), { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';
    let pending = '';
    const read = (chunk) => {
      output += chunk;
      const lines = (pending + chunk).split(/[\r\n]+/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine?.(line.trim());
    };
    child.stdout.setEncoding('utf8').on('data', read);
    child.stderr.setEncoding('utf8').on('data', read);

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(output);
      const error = new Error(`${command} ${args[0] ?? ''} exited with code ${code ?? signal ?? 'unknown'}`);
      error.output = output.trim();
      reject(error);
    });
  });
}
