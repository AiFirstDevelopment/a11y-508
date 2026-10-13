// The assistants' streamed output (Gemini CLI's and Claude Code's --output-format stream-json, one
// JSON event per line) turned into one readable line per thing the assistant does: "Reading
// src/app.html", "Running npm run build", its own words as they come, "Done: 2 files changed".
// For display only: the result file the assistant writes stays the source of truth. A line that is
// not an event either understands is passed on as it is.

import { isAbsolute, relative } from 'node:path';

const str = (v) => (typeof v === 'string' ? v : '');
const oneLine = (s, max = 200) => {
  const t = str(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// What a tool call does, in words. Gemini CLI's tool names and Claude Code's, one table.
const TOOLS = [
  [/^(read_file|read_many_files|Read|NotebookRead)$/, (p, path) => `Reading ${path(p.file_path || p.absolute_path || p.path || p.notebook_path || (Array.isArray(p.paths) ? p.paths.join(', ') : ''))}`],
  [/^(write_file|Write)$/, (p, path) => `Writing ${path(p.file_path || p.path)}`],
  [/^(replace|edit|Edit|MultiEdit|NotebookEdit)$/, (p, path) => `Editing ${path(p.file_path || p.path || p.notebook_path)}`],
  [/^(grep_search|search_file_content|grep|Grep)$/, (p, path) => `Searching for "${oneLine(p.pattern, 80)}"${p.path || p.dir_path ? ` in ${path(p.path || p.dir_path)}` : ''}`],
  [/^(glob|Glob)$/, (p, path) => `Looking for files matching ${oneLine(p.pattern, 80)}${p.path || p.dir_path ? ` in ${path(p.path || p.dir_path)}` : ''}`],
  [/^(list_directory|ls|LS)$/, (p, path) => `Listing ${path(p.path || p.dir_path || '.')}`],
  [/^(run_shell_command|shell|Bash)$/, (p) => `Running ${oneLine(p.command, 160)}`],
  [/^(web_fetch|WebFetch)$/, (p) => `Fetching ${oneLine(p.url || p.prompt, 120)}`],
  [/^(google_web_search|web_search|WebSearch)$/, (p) => `Searching the web for "${oneLine(p.query, 80)}"`],
  [/^(TodoWrite|write_todos)$/, () => 'Updating its to-do list'],
  [/^(Task)$/, (p) => `Starting a helper: ${oneLine(p.description, 80)}`],
];
const CHANGES = /^(write_file|replace|edit|Write|Edit|MultiEdit|NotebookEdit)$/;

// A decoder for one call: push(text) as stdout arrives, end() when it has ended. onLine(line) gets
// each readable line. recognized: whether any event was understood (the output is a stream).
// doneLine(changed, failed, message), when given, words the closing line (the loop says what comes next).
export function streamDecoder(onLine, { cwd = process.cwd(), doneLine = null } = {}) {
  let partial = '';
  let said = ''; // the assistant's words not yet ended by a newline
  const changed = new Set();
  const state = { recognized: false, text: '' };
  const path = (p) => {
    const s = str(p);
    if (!s) return 'a file';
    const r = isAbsolute(s) ? relative(cwd, s) : s;
    return (r && !r.startsWith('..') ? r : s).replace(/\\/g, '/');
  };
  const words = (t, ended = false) => {
    said += t;
    const parts = said.split('\n');
    said = ended ? '' : parts.pop();
    for (const l of parts) if (l.trim()) onLine(l.trimEnd());
  };
  const endWords = () => words('', true);
  const tool = (name, params) => {
    const p = params && typeof params === 'object' ? params : {};
    if (CHANGES.test(name) && (p.file_path || p.path || p.notebook_path)) changed.add(path(p.file_path || p.path || p.notebook_path));
    const row = TOOLS.find(([re]) => re.test(name));
    return row ? row[1](p, path) : `Using ${name}`;
  };
  const done = (failed, message) => {
    endWords();
    if (doneLine) return onLine(doneLine(changed.size, failed, message ? oneLine(message) : null));
    if (failed) return onLine(`Ended with an error${message ? `: ${oneLine(message)}` : ''}`);
    onLine(`Done: ${changed.size ? `${changed.size} file${changed.size === 1 ? '' : 's'} changed` : 'no files changed'}`);
  };
  // One event; true when it was understood (even when it shows nothing).
  const event = (ev) => {
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return false;
    // Gemini CLI
    if (ev.type === 'init' && ('session_id' in ev || 'model' in ev)) return endWords(), onLine(`Started${ev.model ? ` (${ev.model})` : ''}`), true;
    if (ev.type === 'message' && (ev.role === 'user' || ev.role === 'assistant')) {
      // The prompt itself is not news.
      if (ev.role === 'assistant') {
        state.text += str(ev.content);
        words(str(ev.content), !ev.delta);
      }
      return true;
    }
    if (ev.type === 'tool_use' && typeof ev.tool_name === 'string') return endWords(), onLine(tool(ev.tool_name, ev.parameters)), true;
    if (ev.type === 'tool_result' && 'tool_id' in ev) {
      if (ev.status === 'error') endWords(), onLine(`Failed: ${oneLine((ev.error && ev.error.message) || ev.output || 'the tool reported an error')}`);
      return true;
    }
    if (ev.type === 'error' && typeof ev.message === 'string' && !ev.message_id) {
      state.text += `\n${ev.message}`;
      return endWords(), onLine(`${ev.severity === 'warning' ? 'Warning' : 'Error'}: ${oneLine(ev.message)}`), true;
    }
    if (ev.type === 'result' && 'status' in ev && !('subtype' in ev)) {
      const msg = ev.error && ev.error.message;
      if (msg) state.text += `\n${msg}`;
      return done(ev.status === 'error', msg), true;
    }
    // Claude Code
    if (ev.type === 'system' && ev.subtype === 'init') return endWords(), onLine(`Started${ev.model ? ` (${ev.model})` : ''}`), true;
    if (ev.type === 'system') return true;
    if ((ev.type === 'assistant' || ev.type === 'user') && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && ev.type === 'assistant') {
          state.text += `${str(b.text)}\n`;
          words(`${str(b.text)}\n`);
        } else if (b.type === 'tool_use' && typeof b.name === 'string') endWords(), onLine(tool(b.name, b.input));
        else if (b.type === 'tool_result' && b.is_error) {
          const c = Array.isArray(b.content) ? b.content.map((x) => str(x && x.text)).join(' ') : str(b.content);
          endWords(), onLine(`Failed: ${oneLine(c || 'the tool reported an error')}`);
        }
      }
      return true;
    }
    if (ev.type === 'stream_event') return true;
    if (ev.type === 'result' && 'subtype' in ev) {
      if (typeof ev.result === 'string') state.text += `\n${ev.result}`;
      return done(!!ev.is_error, ev.is_error ? ev.result : null), true;
    }
    return false;
  };
  const line = (l) => {
    const t = l.replace(/\r$/, '');
    if (!t.trim()) return;
    if (t.trimStart().startsWith('{')) {
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {}
      if (event(ev)) return void (state.recognized = true);
    }
    endWords();
    onLine(t);
  };
  return {
    push(text) {
      const parts = (partial + text).split('\n');
      partial = parts.pop();
      for (const l of parts) line(l);
    },
    end() {
      if (partial) line(partial);
      partial = '';
      endWords();
    },
    get recognized() {
      return state.recognized;
    },
    // The assistant's own words (and any error it reported), for finding its answer and quota refusals.
    get text() {
      return state.text;
    },
  };
}

// A whole call's stdout as readable lines, and its decoded words.
export function readable(stdout, opts) {
  const lines = [];
  const d = streamDecoder((l) => lines.push(l), opts);
  d.push(String(stdout || ''));
  d.end();
  return { lines, recognized: d.recognized, text: d.text };
}
