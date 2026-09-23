/**
 * Tests for scripts/check-changeset.js (the `pretest` hook) against throwaway
 * git repositories, including the shallow, detached checkouts CI produces.
 * Everything runs against local file:// clones; no network is involved.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BASE_CANDIDATES,
  findChangedChangesets,
  findInvalidChangesets,
  findNewChangesets,
  isOnBase,
  resolveBaseRef,
  run,
} from '../../scripts/check-changeset.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-changeset.js', import.meta.url));
const MISSING_WARNING = 'No new changeset file found';
const NO_BASE_NOTICE = 'Could not resolve a base branch';
const INVALID_ERROR = 'incorrect or missing package reference';

let root;      // temp directory holding every fixture repo
let upstream;  // the repo playing the role of the GitHub remote
let gitEnv;    // isolates fixtures from the developer's own git config

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
}

function writeChangeset(cwd, name, packageName = '"nansen-cli"') {
  writeFileSync(join(cwd, '.changeset', `${name}.md`), `---\n${packageName}: patch\n---\n\n${name}\n`);
}

/** Full clone of `branch`, as a developer checkout has: origin/* refs plus the local branch. */
function fullClone(name, branch) {
  const dir = join(root, name);
  git(root, 'clone', '-q', '--branch', branch, pathToFileURL(upstream).href, dir);
  return dir;
}

/** Depth-1, single-branch, detached clone of `branch`: what actions/checkout produces by default. */
function shallowDetachedClone(name, branch) {
  const dir = join(root, name);
  git(root, 'clone', '-q', '--depth', '1', '--single-branch', '--branch', branch, pathToFileURL(upstream).href, dir);
  git(dir, 'checkout', '-q', '--detach');
  return dir;
}

/** Runs the check in-process and captures what it would print to stderr. */
function check(cwd) {
  const lines = [];
  const exitCode = run(cwd, (line) => lines.push(line));
  return { exitCode, output: lines.join('\n') };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'check-changeset-'));
  const gitconfig = join(root, 'gitconfig');
  writeFileSync(gitconfig, '');
  gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
  };

  upstream = join(root, 'upstream');
  mkdirSync(join(upstream, '.changeset'), { recursive: true });
  git(upstream, 'init', '-q');
  git(upstream, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(upstream, '.changeset', 'README.md'), 'changesets live here\n');
  writeFileSync(join(upstream, 'package.json'), '{ "name": "fixture" }\n');
  writeChangeset(upstream, 'existing');
  writeFileSync(
    join(upstream, '.changeset', 'existing.md'),
    `---\n"nansen-cli": patch\n---\n\n${'existing release note content\n'.repeat(10)}`
  );
  commitAll(upstream, 'initial');

  git(upstream, 'checkout', '-q', '-b', 'no-changeset', 'main');
  writeFileSync(join(upstream, 'feature.txt'), 'feature\n');
  commitAll(upstream, 'feature without a changeset');

  git(upstream, 'checkout', '-q', '-b', 'valid-changeset', 'main');
  writeChangeset(upstream, 'valid');
  commitAll(upstream, 'feature with a changeset');

  git(upstream, 'checkout', '-q', '-b', 'invalid-changeset', 'main');
  writeChangeset(upstream, 'wrong-package', '"some-other-package"');
  commitAll(upstream, 'feature with a mis-named changeset');

  git(upstream, 'checkout', '-q', 'main');
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('check-changeset: base resolution', () => {
  it('prefers origin/main, falls back to a local main, and reports when neither exists', () => {
    const dir = fullClone('base-resolution', 'no-changeset');
    const mainSha = git(dir, 'rev-parse', 'origin/main');
    expect(BASE_CANDIDATES).toEqual(['origin/main', 'main']);
    expect(resolveBaseRef(dir)).toBe('origin/main');

    git(dir, 'remote', 'remove', 'origin');
    expect(resolveBaseRef(dir)).toBeNull();

    git(dir, 'branch', 'main', mainSha);
    expect(resolveBaseRef(dir)).toBe('main');
  });

  it('treats a checked-out main and a detached HEAD at the main commit as the base', () => {
    const dir = fullClone('on-main', 'main');
    expect(isOnBase('origin/main', dir)).toBe(true);
    expect(check(dir)).toEqual({ exitCode: 0, output: '' });

    // A push to main is checked out in CI as a detached HEAD at that commit.
    git(dir, 'checkout', '-q', '--detach');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(isOnBase('origin/main', dir)).toBe(true);
    expect(check(dir)).toEqual({ exitCode: 0, output: '' });
  });

  it('does not mistake a feature branch for the base', () => {
    const dir = fullClone('feature-not-base', 'no-changeset');
    expect(isOnBase('origin/main', dir)).toBe(false);
    git(dir, 'checkout', '-q', '--detach');
    expect(isOnBase('origin/main', dir)).toBe(false);
  });
});

describe('check-changeset: outcomes', () => {
  it('warns (exit 0) when a branch adds no changeset', () => {
    const dir = fullClone('missing', 'no-changeset');
    expect(findNewChangesets('origin/main', dir)).toEqual([]);
    const result = check(dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(MISSING_WARNING);
  });

  it('is silent (exit 0) when a branch adds a changeset for this package', () => {
    const dir = fullClone('valid', 'valid-changeset');
    expect(findNewChangesets('origin/main', dir)).toEqual(['.changeset/valid.md']);
    expect(check(dir)).toEqual({ exitCode: 0, output: '' });
  });

  it('fails (exit 1) when a new changeset names the wrong package', () => {
    const dir = fullClone('invalid', 'invalid-changeset');
    const result = check(dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(INVALID_ERROR);
    expect(result.output).toContain('.changeset/wrong-package.md');
  });

  it('fails when a branch corrupts an existing changeset package reference', () => {
    const dir = fullClone('modified-existing', 'no-changeset');
    writeChangeset(dir, 'existing', '"some-other-package"');
    expect(findNewChangesets('origin/main', dir)).toEqual([]);
    expect(findChangedChangesets('origin/main', dir)).toEqual(['.changeset/existing.md']);

    const result = check(dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(INVALID_ERROR);
    expect(result.output).toContain('.changeset/existing.md');
  });

  it('never reads a changeset path outside the repository changeset directory', () => {
    const dir = fullClone('path-containment', 'no-changeset');
    expect(findInvalidChangesets(['.changeset/../../package.json'], dir))
      .toEqual(['.changeset/../../package.json']);
    expect(findInvalidChangesets(['/etc/passwd'], dir)).toEqual(['/etc/passwd']);
  });

  it('fails when a branch renames an existing changeset with a wrong package reference', () => {
    const dir = fullClone('renamed-existing', 'no-changeset');
    const contents = readFileSync(join(dir, '.changeset', 'existing.md'), 'utf8');
    git(dir, 'mv', '.changeset/existing.md', '.changeset/renamed-existing.md');
    writeFileSync(
      join(dir, '.changeset', 'renamed-existing.md'),
      contents.replace('"nansen-cli"', '"some-other-package"')
    );
    expect(findNewChangesets('origin/main', dir)).toEqual([]);
    expect(findChangedChangesets('origin/main', dir)).toEqual(['.changeset/renamed-existing.md']);

    const result = check(dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(INVALID_ERROR);
    expect(result.output).toContain('.changeset/renamed-existing.md');
  });

  it('still warns when an existing changeset is only edited or deleted', () => {
    const modified = fullClone('modified-valid-existing', 'no-changeset');
    const file = join(modified, '.changeset', 'existing.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}More release detail.\n`);
    expect(check(modified).output).toContain(MISSING_WARNING);

    const deleted = fullClone('deleted-existing', 'no-changeset');
    rmSync(join(deleted, '.changeset', 'existing.md'));
    expect(findChangedChangesets('origin/main', deleted)).toEqual([]);
    expect(check(deleted).output).toContain(MISSING_WARNING);
  });

  it('counts a changeset that is staged but not yet committed', () => {
    const dir = fullClone('staged', 'no-changeset');
    writeChangeset(dir, 'staged-only');
    expect(check(dir).output).toContain(MISSING_WARNING);
    git(dir, 'add', '.changeset/staged-only.md');
    expect(check(dir)).toEqual({ exitCode: 0, output: '' });
  });

  it('reports instead of silently skipping outside a git repository', () => {
    const dir = join(root, 'not-a-repo');
    mkdirSync(dir);
    const result = check(dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(NO_BASE_NOTICE);
  });
});

describe('check-changeset: CI checkouts', () => {
  it('says so when a shallow single-branch checkout has no base, and works once main is fetched', () => {
    const dir = shallowDetachedClone('shallow-pr', 'no-changeset');
    expect(resolveBaseRef(dir)).toBeNull();

    const before = check(dir);
    expect(before.exitCode).toBe(0);
    expect(before.output).toContain(NO_BASE_NOTICE);
    expect(before.output).not.toContain(MISSING_WARNING);

    // The exact fetch the workflow runs before `npm test`.
    git(dir, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    expect(resolveBaseRef(dir)).toBe('origin/main');

    const after = check(dir);
    expect(after.exitCode).toBe(0);
    expect(after.output).toContain(MISSING_WARNING);
  });

  it('still rejects a mis-named changeset from a shallow checkout once main is fetched', () => {
    const dir = shallowDetachedClone('shallow-invalid', 'invalid-changeset');
    git(dir, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    const result = check(dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(INVALID_ERROR);
  });

  it('is a no-op for a shallow detached checkout of the main commit', () => {
    const dir = shallowDetachedClone('shallow-push-main', 'main');
    git(dir, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    expect(check(dir)).toEqual({ exitCode: 0, output: '' });
  });
});

describe('check-changeset: command-line entry point', () => {
  function runScript(cwd) {
    return spawnSync(process.execPath, [SCRIPT], { cwd, env: gitEnv, encoding: 'utf8' });
  }

  it('exits 0 with the warning on stderr when no changeset was added', () => {
    const result = runScript(fullClone('cli-missing', 'no-changeset'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(MISSING_WARNING);
  });

  it('exits 1 when a new changeset names the wrong package', () => {
    const result = runScript(fullClone('cli-invalid', 'invalid-changeset'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(INVALID_ERROR);
  });
});
