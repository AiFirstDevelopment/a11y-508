// The web address of a repository's remote, from what `git remote get-url` prints: the page a
// person opens for a commit or a branch. null for a remote with no web page (a path, a bare
// server), or none at all.

import { spawnSync } from 'node:child_process';

// "git@github.com:org/repo.git" -> "https://github.com/org/repo"; "https://host/org/repo.git" -> the same without .git;
// "ssh://git@host:7999/org/repo.git" -> "https://host/org/repo". Local paths and file: URLs have no web page.
export function webRemote(url) {
  const u = String(url || '').trim();
  if (!u || /^(file:|\/|[A-Za-z]:[\\/]|\.\.?[\\/])/.test(u)) return null;
  let m = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)(?::\d+)?[:/]+(.+?)(?:\.git)?\/?$/.exec(u.replace(/^https?:\/\/(?:[^@/]+@)?/, 'https://'));
  if (/^https?:\/\//.test(u)) {
    try {
      const x = new URL(u);
      return `${x.protocol}//${x.host}${x.pathname.replace(/\.git$/, '').replace(/\/$/, '')}`;
    } catch {
      return null;
    }
  }
  if (!m) return null;
  const [, host, path] = m;
  if (!/\./.test(host) && host !== 'localhost') return null;
  return `https://${host}/${path.replace(/\.git$/, '')}`;
}

// The repository's web address for its "origin", or null.
export function remoteWeb(cwd) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? webRemote(r.stdout) : null;
}

// A commit's page on the repository's web host (the dashboard's git-links.ts keeps the same paths).
export function commitWebUrl(web, sha) {
  if (!web || !sha) return null;
  let host = '';
  try {
    host = new URL(web).host;
  } catch {}
  if (/gitlab/.test(host)) return `${web}/-/commit/${sha}`;
  if (/bitbucket/.test(host)) return `${web}/commits/${sha}`;
  return `${web}/commit/${sha}`;
}
