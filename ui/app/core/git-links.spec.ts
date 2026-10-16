import { describe, expect, it } from 'vitest';
import { branchUrl, commitUrl } from './git-links';

describe('git links', () => {
  it('builds commit and branch links for GitHub, GitLab, Bitbucket and Azure DevOps, and none without a remote', () => {
    expect(commitUrl('https://github.com/org/repo', 'abc1234')).toBe('https://github.com/org/repo/commit/abc1234');
    expect(branchUrl('https://github.com/org/repo', 'a11y-508')).toBe('https://github.com/org/repo/tree/a11y-508');
    expect(commitUrl('https://gitlab.example.gov/g/repo', 'abc1234')).toBe('https://gitlab.example.gov/g/repo/-/commit/abc1234');
    expect(branchUrl('https://gitlab.example.gov/g/repo', 'a11y-508')).toBe('https://gitlab.example.gov/g/repo/-/tree/a11y-508');
    expect(commitUrl('https://bitbucket.example.com/proj/repo', 'abc1234')).toBe('https://bitbucket.example.com/proj/repo/commits/abc1234');
    expect(branchUrl('https://dev.azure.com/org/p/_git/repo', 'a11y-508')).toBe('https://dev.azure.com/org/p/_git/repo?version=GBa11y-508');
    expect(commitUrl(null, 'abc1234')).toBeNull();
    expect(branchUrl('https://github.com/org/repo', null)).toBeNull();
  });
});
