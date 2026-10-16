// Links into the repository's web host for a commit and a branch, from the remote's web address
// (GET /api/env remoteWeb). Each host keeps its own paths; an unknown host gets GitHub's.

export function commitUrl(remoteWeb: string | null | undefined, sha: string | null | undefined): string | null {
  if (!remoteWeb || !sha) return null;
  const host = hostOf(remoteWeb);
  if (/gitlab/.test(host)) return `${remoteWeb}/-/commit/${sha}`;
  if (/bitbucket/.test(host)) return `${remoteWeb}/commits/${sha}`;
  if (/dev\.azure\.com|visualstudio\.com/.test(host)) return `${remoteWeb}/commit/${sha}`;
  return `${remoteWeb}/commit/${sha}`;
}

export function branchUrl(remoteWeb: string | null | undefined, branch: string | null | undefined): string | null {
  if (!remoteWeb || !branch) return null;
  const host = hostOf(remoteWeb);
  const b = encodeURIComponent(branch).replace(/%2F/g, '/');
  if (/gitlab/.test(host)) return `${remoteWeb}/-/tree/${b}`;
  if (/bitbucket/.test(host)) return `${remoteWeb}/branch/${b}`;
  if (/dev\.azure\.com|visualstudio\.com/.test(host)) return `${remoteWeb}?version=GB${b}`;
  return `${remoteWeb}/tree/${b}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
