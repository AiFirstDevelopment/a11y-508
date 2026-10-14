// The agent adapter: runs the configured AI coding assistant once per
// bounded task. The task is written to a prompt file, the command gets that
// path, and the assistant answers by writing a JSON result file. Nothing
// secret is in the prompt, and the token is stripped from the environment.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { streamDecoder } from './agent-stream.mjs';

// The prompt and result files are in the tool's tasks folder under the state base, outside the
// repository the assistant works in: each preset is given that one folder ({tasksDir}) besides the
// repository, so it can read the prompt and write the result, and nothing else of the tool's.
// Gemini CLI gets the prompt on stdin rather than by path; it joins stdin and -p into one prompt.
export const PRESETS = {
  claude: 'claude -p --permission-mode acceptEdits --add-dir "{tasksDir}" --output-format stream-json --verbose "Read the file {promptFile} and do exactly what it says."',
  gemini: 'gemini --approval-mode auto_edit --include-directories "{tasksDir}" -p "Do exactly what the instructions above say." --output-format stream-json < "{promptFile}"',
  codex: 'codex exec --full-auto --add-dir "{tasksDir}" "Read the file {promptFile} and do exactly what it says."',
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
  // A Windows path is quoted as it is: JSON.stringify would double its backslashes.
  const quoted = !/[\s"']/.test(exePath) ? exePath : /\\/.test(exePath) && !/"/.test(exePath) ? `"${exePath}"` : JSON.stringify(exePath);
  return quoted + cmd.slice(PRESET_INFO[name].bin.length);
}

// The command a person can paste into their own shell to run the assistant on a prompt
// file by hand, as the loop runs it: the resolved executable, the real prompt path, the
// environment the loop sets spelled out for that shell, and stdin redirected as the preset does.
export function runnableCommand({ name, exePath = null, promptFile, shell = 'sh', platform = process.platform }) {
  const template = PRESETS[name];
  if (!template) return null;
  const k = shellKind(shell);
  const exe = exePath || PRESET_INFO[name].bin;
  const quote = (p) => (!/[\s"'&()]/.test(p) ? p : k === 'powershell' ? `'${p.replace(/'/g, "''")}'` : `"${p}"`);
  let rest = template.slice(PRESET_INFO[name].bin.length);
  let stdin = null;
  const m = / < "\{promptFile\}"$/.exec(rest);
  if (m) {
    stdin = promptFile;
    rest = rest.slice(0, m.index);
  }
  rest = rest.split('{promptFile}').join(promptFile).split('{tasksDir}').join(dirname(promptFile));
  const env = agentEnvFor(`"${exe}"`, {}).GEMINI_CLI_TRUST_WORKSPACE ? [['GEMINI_CLI_TRUST_WORKSPACE', 'true']] : [];
  if (k === 'powershell') {
    const call = `${/[\s'"]/.test(exe) ? `& ${quote(exe)}` : exe}${rest}`;
    const pre = env.map(([n, v]) => `$env:${n}='${v}'; `).join('');
    return `${pre}${stdin ? `Get-Content -Raw ${quote(stdin)} | ` : ''}${call}`;
  }
  if (k === 'cmd') {
    const pre = env.map(([n, v]) => `set ${n}=${v}&& `).join('');
    return `${pre}${quote(exe)}${rest}${stdin ? ` < "${stdin}"` : ''}`;
  }
  const pre = env.map(([n, v]) => `${n}=${v} `).join('');
  return `${pre}${quote(exe)}${rest}${stdin ? ` < "${stdin}"` : ''}`;
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

// C:\Users\dev\npm as Git Bash writes it: /c/Users/dev/npm.
const msysPath = (dir) => (/^[A-Za-z]:[\\/]/.test(dir) ? `/${dir[0].toLowerCase()}${dir.slice(2).replace(/\\/g, '/')}` : dir);

// The command that puts dir on PATH for every new shell of this kind.
export function pathLine(dir, shell) {
  const k = shellKind(shell);
  if (k !== 'powershell' && k !== 'cmd') dir = msysPath(dir);
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
      // On Windows npm puts executables in the prefix itself, not prefix/bin;
      // Git Bash gets the POSIX form, PowerShell and cmd the Windows one.
      command: isWin(platform) && ['powershell', 'cmd'].includes(shellKind(shell))
        ? 'npm config set prefix "$env:APPDATA\\npm"'
        : `npm config set prefix ~/.npm-global && ${pathLine(isWin(platform) ? '$HOME/.npm-global' : '$HOME/.npm-global/bin', shell)}`,
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

// Output that says the assistant's provider refused the call for quota or rate (free tiers limit
// requests per minute and per day): HTTP 429, Google's RESOURCE_EXHAUSTED, and the usual wording.
export const QUOTA = /\b429\b|RESOURCE_EXHAUSTED|\bquota\b|rate[ -]?limit|too many requests/i;
// Waits before each retry of a call refused for quota: two retries, then the call is given up.
export const QUOTA_DELAYS = [30000, 90000];
// A quota that resets in hours (a free tier's daily limit) is not worth waiting for in seconds.
export const QUOTA_TERMINAL = /daily quota|TerminalQuotaError|per day|retry in \d+h/i;

// Gemini CLI refuses to run headless in a folder it has not been told to trust; the loop runs it
// in the repository it was configured for, so it says so. Any other command's environment is
// left as it is.
export function agentEnvFor(command, env = agentEnv()) {
  // A quoted executable may hold spaces ("C:\\Program Files\\nodejs\\gemini.cmd" ...).
  const t = String(command || '').trim();
  const exe = (t.startsWith('"') ? t.slice(1, t.indexOf('"', 1) > 0 ? t.indexOf('"', 1) : undefined) : t.split(/\s+/)[0]) || '';
  if (/(^|[\\/])gemini(\.cmd|\.exe|\.ps1)?$/i.test(exe) && env.GEMINI_CLI_TRUST_WORKSPACE === undefined) return { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
  return env;
}

// Runs the assistant once on a prompt file. A call that writes no result and whose output names a
// quota or rate limit is run again after each of quotaDelays; quota says the last try was refused
// that way, quotaRetries how many retries it took.
// onOutput(stream, text), when given, sees the assistant's output as it arrives.
// onWait({ delayMs, attempt, attempts }), when given, is told before each wait for a quota retry.
// doneLine words a streaming assistant's closing line (see streamDecoder).
export async function runAgent({ command, promptFile, resultFile, cwd, tasksDir = dirname(promptFile), timeout = 15 * 60 * 1000, env = agentEnvFor(command), quotaDelays = QUOTA_DELAYS, onOutput = null, onWait = null, doneLine = null }) {
  const t0 = Date.now();
  let quotaRetries = 0;
  for (;;) {
    const r = await runAgentOnce({ command, promptFile, resultFile, cwd, tasksDir, timeout, env, onOutput, doneLine });
    // A call that ran out its time while the assistant backed off on its own counts as refused for
    // quota too, but is not run again: it has already spent its time.
    // The refusal may arrive inside a stream's JSON events: their decoded words are searched too.
    const said = `${r.stdout}\n${r.stderr}\n${r.text || ''}`;
    const quota = !r.result && QUOTA.test(said);
    if (quota && !r.timedOut && !QUOTA_TERMINAL.test(said) && quotaRetries < quotaDelays.length) {
      if (onWait) onWait({ delayMs: quotaDelays[quotaRetries], attempt: quotaRetries + 1, attempts: quotaDelays.length });
      await new Promise((res) => setTimeout(res, quotaDelays[quotaRetries]));
      quotaRetries++;
      continue;
    }
    return { ...r, quota, quotaRetries, durationMs: Date.now() - t0 };
  }
}

async function runAgentOnce({ command, promptFile, resultFile, cwd, tasksDir, timeout, env, onOutput, doneLine }) {
  const cmd = command.split('{promptFile}').join(promptFile).split('{resultFile}').join(resultFile).split('{tasksDir}').join(tasksDir);
  if (existsSync(resultFile)) rmSync(resultFile, { force: true });
  const child = spawn(cmd, { cwd, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const keep = (s, d) => (s + d).slice(-20000);
  // A streaming assistant's JSON events reach onOutput as readable lines, as they arrive.
  const decoder = streamDecoder((line) => onOutput && onOutput('stdout', `${line}\n`), { cwd, doneLine });
  child.stdout.on('data', (d) => {
    stdout = keep(stdout, String(d));
    decoder.push(String(d));
  });
  child.stderr.on('data', (d) => {
    stderr = keep(stderr, String(d));
    if (onOutput) onOutput('stderr', String(d));
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // On Windows the command runs under cmd.exe, and killing cmd.exe leaves the assistant running
    // (it would keep retrying, and keep a CI step alive); taskkill /T ends the whole tree.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {});
    child.kill('SIGKILL');
  }, timeout);
  const closed = new Promise((r) => child.on('close', r));
  const code = await new Promise((r) => child.on('exit', r));
  clearTimeout(timer);
  // The last of its output can arrive after it exits; wait for the pipes, but not for a grandchild
  // that keeps them open.
  await Promise.race([closed, new Promise((r) => setTimeout(r, 2000).unref())]);
  decoder.end();
  // A grandchild still holding the pipes (an assistant that outlived its shell) must not keep the
  // loop's own process alive after it is done: let go of them.
  for (const stream of [child.stdout, child.stderr]) {
    try {
      stream.destroy();
    } catch {}
  }
  let result = null;
  if (existsSync(resultFile)) {
    try {
      result = JSON.parse(readFileSync(resultFile, 'utf8'));
    } catch {}
  }
  // Without a result file, the answer at the end of what it said: its words, when it streamed events.
  if (!result) result = lastJson(decoder.recognized ? decoder.text : stdout);
  return { code, timedOut, result, stdout, stderr, text: decoder.text };
}

// What one agent call left behind, for the work folder: a JSON header line, then the tail of its
// output. Never the environment or the token (the prompt and the agent never had it).
export function agentLog(res) {
  const head = { code: res.code, timedOut: !!res.timedOut, quota: !!res.quota, quotaRetries: res.quotaRetries || 0, result: !!res.result, durationMs: res.durationMs };
  return `${JSON.stringify(head)}\n--- stdout (tail)\n${String(res.stdout || '').slice(-8000)}\n--- stderr (tail)\n${String(res.stderr || '').slice(-8000)}\n`;
}

const block = (obj) => '```json\n' + JSON.stringify(obj, null, 2) + '\n```';

// group: the findings that are the same problem on different elements (finding among them), fixed as one task.
// What keeps the assistant on the app's source and off the tool's own bookkeeping.
export const FOCUS = "Everything you need is in this prompt. Do not read, search or edit anything outside the source folders listed above; in particular leave the tool's own folders alone.";

export function fixPrompt({ finding, group = null, sourceDirs, protectedDirs, resultFile, condition }) {
  const prior = finding.attempts.filter((a) => a.outcome && a.outcome !== 'pending');
  const many = Array.isArray(group) && group.length > 1 ? group : null;
  const elements = many ? `\n## The same problem on ${many.length} elements\n\nThese ${many.length} findings are the same problem on different elements; fix the cause once if there is one, otherwise fix each.\n\n${many.map((e, i) => `${i + 1}. Selector: ${e.selector || '(page level)'}${e.frame ? ` (inside the frame ${e.frame})` : ''}; seen on ${e.pages.slice(0, 5).join(', ')}${e.pages.length > 5 ? ', ...' : ''}\n\n\`\`\`html\n${(e.html || '').slice(0, 600)}\n\`\`\``).join('\n\n')}\n` : '';
  return `# Fix one accessibility ${many ? `problem on ${many.length} elements` : 'finding'}

You are working in this repository. Fix the finding below by editing the application's source files. Rules:

- Edit only files under: ${sourceDirs.join(', ')}.
- ${protectedDirs && protectedDirs.length ? `Never edit anything under: ${protectedDirs.join(', ')}. ` : ''}Do not edit tests to make them pass, do not add or remove dependencies, do not commit, and do not run the accessibility crawler.
- ${FOCUS}
- Do not search or read node_modules or other installed dependencies: the fix belongs in the application's own source, and reading packages only costs time.
- Make the smallest change that resolves this finding everywhere it appears. The same element is often rendered by one component or template used on many pages.
- Do not change the page's behavior or visual design beyond what the fix requires.
- If you cannot locate the element, or the fix needs a decision only a person can make (for example what an image depicts), make no change and say so in the result.

## The finding

Section 508 Trusted Tester test ${finding.test} (${finding.name}), WCAG ${finding.wcag}, impact ${finding.impact}.
Condition tested: ${condition}

Message: ${finding.message}
Seen on ${finding.pages.length} page(s): ${finding.pages.slice(0, 5).join(', ')}${finding.pages.length > 5 ? ', ...' : ''}
Element selector: ${finding.selector || '(page level)'}
${finding.frame ? `Inside the same-origin frame: ${finding.frame}\n` : ''}${/ >>> /.test(finding.selector || '') ? 'In the selector, " >>> " steps into the shadow root of the element before it (a web component) or into the document of the frame before it; the part after it is a path inside that component or frame, so the fix usually belongs in that component\'s template or the framed page.\n' : ''}${finding.state ? `State when seen: ${finding.state}\n` : ''}Rendered HTML:

\`\`\`html
${(finding.html || '').slice(0, 2000)}
\`\`\`
${elements}${prior.length ? `\n## Earlier attempts that did not work\n\n${prior.map((a) => `- Round ${a.round}: ${a.note || 'no note'} (files: ${(a.files || []).join(', ') || 'none'}; outcome: ${a.outcome})`).join('\n')}\n\nThe finding was still present after those changes, so try a different approach.\n` : ''}
## How to find it in the source

Search the source folders for the class names, ids, attribute values, text and tag names in the rendered HTML. Framework templates (Angular, React, Vue) usually contain the same literals. If the HTML is generated from data, fix the component that renders it.

## When you are done

Write a JSON file at ${resultFile} with exactly this shape and nothing else:

${block({ fixed: true, files: ['path/of/each/file/you/changed'], note: 'one sentence saying what you changed and why' })}

If you made no change, write it with "fixed": false and a note explaining why.

Machine-readable copy of the finding:

${block({ kind: 'fix', finding: { test: finding.test, name: finding.name, wcag: finding.wcag, impact: finding.impact, message: finding.message, selector: finding.selector, ...(finding.frame ? { frame: finding.frame } : {}), html: finding.html, pages: finding.pages }, ...(many ? { elements: many.map((e) => ({ selector: e.selector, html: e.html, pages: e.pages })) } : {}), sourceDirs, resultFile })}
`;
}

export function triagePrompt({ items, resultFile }) {
  return `# Judge accessibility review items

An automated Section 508 crawl escalated the items below because it could not decide them on its own. For each one, decide whether the current content is adequate for people using assistive technology. Do not edit any file.

Everything you need is in this prompt. Do not read, search or edit anything other than the result file named below; in particular leave the tool's own folders alone.

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
