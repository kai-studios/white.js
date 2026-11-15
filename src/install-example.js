import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const examples = {
  site: 'https://github.com/kai-studios/white-generator.git',
};

const isTerminal = process.stdout.isTTY;

function fail(message) {
  console.error(`White.js: ${message}`);
  process.exit(1);
}

function renderProgress(label, percent) {
  if (!isTerminal) {
    if (percent === 0 || percent === 100 || percent % 10 === 0) {
      console.log(`${label}: ${percent}%`);
    }
    return;
  }

  const width = 28;
  const filled = Math.round((percent / 100) * width);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  process.stdout.write(`\r${label}  \x1b[36m${bar}\x1b[0m  ${String(percent).padStart(3)}%`);
}

function finishProgress() {
  if (isTerminal) process.stdout.write('\n');
}

async function askForFolder(defaultName) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultName;

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`Folder name [${defaultName}]: `);
    return answer.trim() || defaultName;
  } finally {
    readline.close();
  }
}

function isValidFolderName(name) {
  return (
    /^[\p{L}\p{N}_][\p{L}\p{N} ._-]*$/u.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}

function cloneExample(repository, checkout) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--progress', repository, checkout], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let pending = '';
    let output = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      output += chunk;
      const lines = (pending + chunk).split(/[\r\n]+/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const progress = /(Receiving objects|Resolving deltas):\s+(\d+)%/.exec(line);
        if (!progress) continue;

        const value = Number(progress[2]);
        const percent =
          progress[1] === 'Receiving objects'
            ? 5 + Math.round((value * 40) / 100)
            : 45 + Math.round((value * 15) / 100);
        renderProgress('Downloading template', percent);
      }
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      finishProgress();
      if (code === 0) return resolve();
      reject(new Error(`git clone exited with code ${code ?? signal ?? 'unknown'}.\n${output.trim()}`));
    });
  });
}

function installDependencies(target) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const command = windows ? process.env.ComSpec || 'cmd.exe' : 'npm';
    const args = windows
      ? ['/d', '/s', '/c', 'npm install --no-audit --no-fund --progress']
      : ['install', '--no-audit', '--no-fund', '--progress'];
    const child = spawn(command, args, { cwd: target, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`npm install exited with code ${code ?? signal ?? 'unknown'}.`));
    });
  });
}

export async function installExample(args) {
  const [specifier, ...extra] = args;
  if (!specifier || extra.length) {
    console.log('Usage: white install example:<name>');
    process.exit(specifier ? 1 : 0);
  }

  const match = /^example:([a-z0-9][a-z0-9-]*)$/.exec(specifier);
  if (!match) fail(`Invalid example: ${specifier}`);

  const exampleName = match[1];
  const repository = examples[exampleName];
  if (!repository) {
    fail(`Unknown example "${exampleName}". Available examples: ${Object.keys(examples).join(', ')}`);
  }

  const folderName = await askForFolder(exampleName);
  if (!isValidFolderName(folderName)) {
    fail('Folder name contains unsupported characters or is reserved by the operating system.');
  }

  const target = path.resolve(process.cwd(), folderName);
  if (fs.existsSync(target)) fail(`Target already exists: ${target}`);

  const staging = fs.mkdtempSync(path.join(process.cwd(), `.white-install-${exampleName}-`));
  const checkout = path.join(staging, 'repo');
  renderProgress('Downloading template', 0);

  try {
    await cloneExample(repository, checkout);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    fail(`Could not download example "${exampleName}": ${error.message}`);
  }

  fs.rmSync(path.join(checkout, '.git'), { recursive: true, force: true });
  fs.renameSync(checkout, target);
  fs.rmSync(staging, { recursive: true, force: true });
  renderProgress('Downloading template', 60);
  finishProgress();

  console.log('Installing dependencies...');
  try {
    await installDependencies(target);
  } catch (error) {
    console.error(`White.js: ${error.message}`);
    console.error(`Project files are in "${folderName}". To retry, run: cd "${folderName}" and npm install.`);
    process.exit(1);
  }

  renderProgress('Installation complete', 100);
  finishProgress();
  console.log(`\nDone! Project created in "${folderName}".`);
  console.log(`  cd "${folderName}"`);
  console.log('  npm run dev');
  console.log('  npm start');
}
