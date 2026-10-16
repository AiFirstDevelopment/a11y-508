import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webRemote } from '../git-web.mjs';

test('git web: the remote\'s web address for the usual forms, none for a path', () => {
  assert.equal(webRemote('git@github.com:org/repo.git'), 'https://github.com/org/repo');
  assert.equal(webRemote('https://github.com/org/repo.git'), 'https://github.com/org/repo');
  assert.equal(webRemote('https://user@gitlab.example.gov/group/sub/repo.git'), 'https://gitlab.example.gov/group/sub/repo');
  assert.equal(webRemote('ssh://git@bitbucket.example.com:7999/proj/repo.git'), 'https://bitbucket.example.com/proj/repo');
  assert.equal(webRemote('https://dev.azure.com/org/project/_git/repo'), 'https://dev.azure.com/org/project/_git/repo');
  assert.equal(webRemote('/Users/x/origin.git'), null);
  assert.equal(webRemote('C:\\git\\origin'), null);
  assert.equal(webRemote('file:///tmp/origin'), null);
  assert.equal(webRemote(''), null);
});
