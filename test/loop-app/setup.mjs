// Creates a throwaway git repository for an end-to-end run of the fix loop against the loop test
// app: the app (site/, server.mjs, check.mjs) at its root, an a11y-508.config.json, a .gitignore,
// and one commit.
//
//   node test/loop-app/setup.mjs <new directory> [--agent gemini|claude|codex|<command>] [--port 4321]
//
// Then, in that directory: node server.mjs & and node <tool>/bin/a11y-508.mjs loop --max-rounds 2.
// The directory must not exist yet, or be empty.

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const target = argv[0] && !argv[0].startsWith('--') ? resolve(argv[0]) : null;
if (!target) {
  console.error('usage: node test/loop-app/setup.mjs <new directory> [--agent gemini] [--port 4321]');
  process.exit(2);
}
if (existsSync(target) && readdirSync(target).length) {
  console.error(`${target} is not empty`);
  process.exit(2);
}
const agent = opt('--agent', 'gemini');
const port = Number(opt('--port', '4321'));

mkdirSync(target, { recursive: true });
cpSync(join(here, 'site'), join(target, 'site'), { recursive: true });
for (const f of ['server.mjs', 'check.mjs']) cpSync(join(here, f), join(target, f));
writeFileSync(join(target, '.gitignore'), 'a11y-508-gate.log\nnode_modules/\n');
writeFileSync(join(target, 'a11y-508.config.json'), JSON.stringify({
  url: `http://127.0.0.1:${port}/`,
  args: ['--max-pages', '10', '--no-screenshots'],
  agent,
  source: ['site'],
  check: 'node check.mjs',
  push: false,
  deployed: 'none',
  maxAttempts: 2,
  // Small triage batches and a three-minute limit per call: a stuck or rate-limited call costs
  // three minutes, not fifteen.
  triageBatch: 8,
  agentTimeout: 3 * 60 * 1000,
}, null, 2) + '\n');

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: target, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'a11y-508 loop test');
git('config', 'user.email', 'loop-test@example.invalid');
git('config', 'core.autocrlf', 'false');
git('add', '-A');
git('commit', '-q', '-m', 'The loop test app, with its planted violations');
console.log(`loop test repository ready at ${target} (agent ${agent}, port ${port})`);
