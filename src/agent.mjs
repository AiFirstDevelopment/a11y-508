// The agent adapter: runs the configured AI coding assistant once per
// bounded task. The task is written to a prompt file, the command gets that
// path, and the assistant answers by writing a JSON result file. Nothing
// secret is in the prompt, and the token is stripped from the environment.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export const PRESETS = {
  claude: 'claude -p --permission-mode acceptEdits "Read the file {promptFile} and do exactly what it says."',
  gemini: 'gemini --approval-mode auto_edit -p "Read the file {promptFile} and do exactly what it says."',
  codex: 'codex exec --full-auto "Read the file {promptFile} and do exactly what it says."',
};

// What each preset is called on screen and the executable it runs.
export const PRESET_INFO = {
  claude: { label: 'Claude Code', bin: 'claude', package: '@anthropic-ai/claude-code' },
  gemini: { label: 'Gemini CLI', bin: 'gemini', package: '@google/gemini-cli' },
  codex: { label: 'Codex', bin: 'codex', package: '@openai/codex' },
};

// The install command per preset and operating system. Fixed here, never
// taken from a request.
export const INSTALL = Object.fromEntries(
  Object.entries(PRESET_INFO).map(([name, p]) => [name, { default: `npm install -g ${p.package}` }])
);

export function installCommand(name, platform = process.platform) {
  const row = INSTALL[name];
  if (!row) return null;
  return row[platform] || row.default;
}

// The preset's command with its executable replaced by an absolute path, for
// a CLI that was found somewhere other than PATH.
export function presetCommandAt(name, exePath) {
  const cmd = PRESETS[name];
  if (!cmd || !exePath) return cmd || null;
  const quoted = /[\s"']/.test(exePath) ? JSON.stringify(exePath) : exePath;
  return quoted + cmd.slice(PRESET_INFO[name].bin.length);
}

const isWin = (platform) => platform === 'win32';
const shellKind = (shell = '') => {
  const s = String(shell).toLowerCase();
  if (/pwsh|powershell/.test(s)) return 'powershell';
  if (/(^|[\\/])cmd(\.exe)?$/.test(s) || s === 'cmd') return 'cmd';
  if (/fish/.test(s)) return 'fish';
  if (/bash/.test(s)) return 'bash';
  if (/zsh/.test(s)) return 'zsh';
  return 'sh';
};

export function rcFile(shell) {
  return { zsh: '~/.zshrc', bash: '~/.bashrc', fish: '~/.config/fish/config.fish', powershell: '$PROFILE', cmd: null, sh: '~/.profile' }[shellKind(shell)];
}

// The command that puts dir on PATH for every new shell of this kind.
export function pathLine(dir, shell) {
  const k = shellKind(shell);
  if (k === 'fish') return `fish_add_path ${dir}`;
  if (k === 'powershell') return `Add-Content $PROFILE '$env:Path = "${dir};" + $env:Path'`;
  if (k === 'cmd') return `setx PATH "${dir};%PATH%"`;
  return `echo 'export PATH="${dir}:$PATH"' >> ${rcFile(shell)}`;
}

const setEnvLine = (name, value, shell) => {
  const k = shellKind(shell);
  if (k === 'fish') return `set -Ux ${name} ${value}`;
  if (k === 'powershell') return `[Environment]::SetEnvironmentVariable('${name}', '${value}', 'User')`;
  if (k === 'cmd') return `setx ${name} "${value}"`;
  return `echo 'export ${name}="${value}"' >> ${rcFile(shell)}`;
};

export const npmBinDir = (prefix, platform = process.platform) => (prefix ? (isWin(platform) ? prefix : `${prefix.replace(/\/+$/, '')}/bin`) : null);

// Why an install failed, and what to do about it: a fixed table, tried in
// order (most specific first); every row that matches is returned. Pure: the
// same inputs always give the same remedies.
export const REMEDY_ROWS = [
  {
    id: 'tls',
    match: ({ output }) => /SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT|CERT_HAS_EXPIRED/.test(output),
    remedy: ({ shell }) => ({
      text: 'Something on the network is inspecting TLS traffic, so npm does not trust the registry\'s certificate. Point Node at your company\'s CA bundle with NODE_EXTRA_CA_CERTS, then retry. Never turn off strict-ssl.',
      command: setEnvLine('NODE_EXTRA_CA_CERTS', '/path/to/company-ca.pem', shell),
    }),
  },
  {
    id: 'execution-policy',
    match: ({ output }) => /running scripts is disabled|ExecutionPolicy/i.test(output),
    remedy: () => ({ text: 'PowerShell\'s execution policy blocks npm\'s script shim. Allow signed and local scripts for your user, then retry.', command: 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned' }),
  },
  {
    id: 'node-too-old',
    match: ({ output }) => /EBADENGINE|Unsupported engine|requires Node/i.test(output),
    remedy: ({ platform }) => ({ text: 'This assistant needs a newer Node.js than the one this shell runs. Install the current LTS (with nvm, or from nodejs.org), then retry.', command: isWin(platform) ? null : 'nvm install --lts' }),
  },
  {
    id: 'not-on-registry',
    match: ({ output }) => /\bE404\b|\bETARGET\b/.test(output),
    remedy: () => ({ text: 'The npm registry this machine is configured for does not carry the package. Check which registry that is, and ask for the package to be mirrored there.', command: 'npm config get registry' }),
  },
  {
    id: 'disk',
    match: ({ output }) => /\bENOSPC\b/.test(output),
    remedy: () => ({ text: 'The disk is full. Free some space, then retry.', command: null }),
  },
  {
    id: 'permission',
    match: ({ output }) => /\bEACCES\b|\bEPERM\b|permission denied/i.test(output),
    remedy: ({ shell, platform }) => ({
      text: 'npm\'s global folder is not writable by you. Give npm a folder in your home directory and put it on PATH, then retry. Do not use sudo.',
      command: isWin(platform)
        ? 'npm config set prefix "$env:APPDATA\\npm"'
        : `npm config set prefix ~/.npm-global && ${pathLine('$HOME/.npm-global/bin', shell)}`,
    }),
  },
  {
    id: 'network',
    match: ({ output }) => /\bENOTFOUND\b|\bEAI_AGAIN\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bECONNRESET\b|\b407\b/.test(output),
    remedy: () => ({
      text: 'The npm registry could not be reached. Check the VPN or proxy; set npm config set proxy and https-proxy if a proxy is required, or point npm config set registry at the internal mirror.',
      command: 'npm config get registry && npm config get https-proxy',
    }),
  },
  {
    id: 'npm-missing',
    match: ({ output }) => /npm: command not found|command not found: npm|npm: not found|'npm' is not recognized|spawn\s+\S*\s*ENOENT/i.test(output),
    remedy: ({ platform }) => ({ text: 'Node.js is not on this shell\'s PATH, so there is no npm to install with. Install Node.js 18 or newer, or run nvm use, then retry.', command: isWin(platform) ? null : 'nvm use --lts' }),
  },
  {
    id: 'not-on-path',
    match: ({ code, found }) => code === 0 && !found,
    remedy: ({ shell, platform, npmPrefix }) => {
      const dir = npmBinDir(npmPrefix, platform) || '<npm prefix -g>/bin';
      return { text: `The install finished, but npm's global bin directory (${dir}) is not on PATH, so the assistant cannot be found. Add it for new shells, open a new terminal, and retry.`, command: pathLine(dir, shell) };
    },
  },
];

export function installRemedies({ code, output = '', shell = '', platform = process.platform, found = false, npmPrefix = null }) {
  if (code === 0 && found) return [];
  const ctx = { code, output: String(output), shell, platform, found, npmPrefix };
  const hits = REMEDY_ROWS.filter((r) => r.match(ctx)).map((r) => ({ id: r.id, ...r.remedy(ctx) }));
  if (hits.length) return hits;
  return [{ id: 'unknown', text: `No known cause matched (exit code ${code}). The full output is below; run the same command in a terminal to see more.`, command: null }];
}

export function resolveAgentCommand(spec) {
  if (!spec) return null;
  return PRESETS[spec] || spec;
}

const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY/i;
export function agentEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET.test(k) || /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|CLAUDE|CODEX)_/i.test(k)) out[k] = v;
  return out;
}

function lastJson(text) {
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  for (let i = start; i >= 0; i = text.lastIndexOf('{', i - 1)) {
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {}
    if (i === 0) break;
  }
  return null;
}

export async function runAgent({ command, promptFile, resultFile, cwd, timeout = 15 * 60 * 1000, env = agentEnv() }) {
  const cmd = command.split('{promptFile}').join(promptFile).split('{resultFile}').join(resultFile);
  if (existsSync(resultFile)) rmSync(resultFile, { force: true });
  const t0 = Date.now();
  const child = spawn(cmd, { cwd, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const keep = (s, d) => (s + d).slice(-20000);
  child.stdout.on('data', (d) => (stdout = keep(stdout, String(d))));
  child.stderr.on('data', (d) => (stderr = keep(stderr, String(d))));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeout);
  const code = await new Promise((r) => child.on('exit', r));
  clearTimeout(timer);
  let result = null;
  if (existsSync(resultFile)) {
    try {
      result = JSON.parse(readFileSync(resultFile, 'utf8'));
    } catch {}
  }
  if (!result) result = lastJson(stdout);
  return { code, timedOut, result, stdout, stderr, durationMs: Date.now() - t0 };
}

const block = (obj) => '```json\n' + JSON.stringify(obj, null, 2) + '\n```';

export function fixPrompt({ finding, sourceDirs, protectedDirs, resultFile, condition }) {
  const prior = finding.attempts.filter((a) => a.outcome && a.outcome !== 'pending');
  return `# Fix one accessibility finding

You are working in this repository. Fix the finding below by editing the application's source files. Rules:

- Edit only files under: ${sourceDirs.join(', ')}.
- Never edit anything under: ${protectedDirs.join(', ')}. Do not edit tests to make them pass, do not add or remove dependencies, do not commit, and do not run the accessibility crawler.
- Make the smallest change that resolves this finding everywhere it appears. The same element is often rendered by one component or template used on many pages.
- Do not change the page's behavior or visual design beyond what the fix requires.
- If you cannot locate the element, or the fix needs a decision only a person can make (for example what an image depicts), make no change and say so in the result.

## The finding

Section 508 Trusted Tester test ${finding.test} (${finding.name}), WCAG ${finding.wcag}, impact ${finding.impact}.
Condition tested: ${condition}

Message: ${finding.message}
Seen on ${finding.pages.length} page(s): ${finding.pages.slice(0, 5).join(', ')}${finding.pages.length > 5 ? ', ...' : ''}
Element selector: ${finding.selector || '(page level)'}
${finding.state ? `State when seen: ${finding.state}\n` : ''}Rendered HTML:

\`\`\`html
${(finding.html || '').slice(0, 2000)}
\`\`\`
${prior.length ? `\n## Earlier attempts that did not work\n\n${prior.map((a) => `- Round ${a.round}: ${a.note || 'no note'} (files: ${(a.files || []).join(', ') || 'none'}; outcome: ${a.outcome})`).join('\n')}\n\nThe finding was still present after those changes, so try a different approach.\n` : ''}
## How to find it in the source

Search the source folders for the class names, ids, attribute values, text and tag names in the rendered HTML. Framework templates (Angular, React, Vue) usually contain the same literals. If the HTML is generated from data, fix the component that renders it.

## When you are done

Write a JSON file at ${resultFile} with exactly this shape and nothing else:

${block({ fixed: true, files: ['path/of/each/file/you/changed'], note: 'one sentence saying what you changed and why' })}

If you made no change, write it with "fixed": false and a note explaining why.

Machine-readable copy of the finding:

${block({ kind: 'fix', finding: { test: finding.test, name: finding.name, wcag: finding.wcag, impact: finding.impact, message: finding.message, selector: finding.selector, html: finding.html, pages: finding.pages }, sourceDirs, resultFile })}
`;
}

export function triagePrompt({ items, resultFile }) {
  return `# Judge accessibility review items

An automated Section 508 crawl escalated the items below because it could not decide them on its own. For each one, decide whether the current content is adequate for people using assistive technology. Do not edit any file.

- "adequate": the content meets the test condition as it is.
- "inadequate": it does not; it needs a fix.
- "unsure": a person must look (for example, judging what an image depicts requires seeing it).

## Items

${items.map((it, i) => `### ${i + 1}. id ${it.id}\nTest ${it.test} (${it.name}), WCAG ${it.wcag}. Condition: ${it.condition}\nMessage: ${it.message}\nPage: ${it.pages[0]}\nSelector: ${it.selector || '(page level)'}\n\n\`\`\`html\n${(it.html || '').slice(0, 1200)}\n\`\`\``).join('\n\n')}

## When you are done

Write a JSON file at ${resultFile} with exactly this shape and nothing else: an array with one object per item, in any order.

${block([{ id: items[0] ? items[0].id : 'id', decision: 'adequate | inadequate | unsure', reason: 'one sentence' }])}

Machine-readable copy:

${block({ kind: 'triage', items: items.map((it) => ({ id: it.id, test: it.test, message: it.message, selector: it.selector, html: it.html, page: it.pages[0] })), resultFile })}
`;
}

export function writePrompt(file, text) {
  writeFileSync(file, text);
}
