#!/usr/bin/env node

/**
 * Changeset validation script. Runs as a pretest hook.
 *
 * - Missing changeset: warning only (exit 0) — not every PR needs one.
 * - Invalid package name: hard failure (exit 1) — a wrong name silently skips
 *   the version bump during `changeset version`, breaking the release PR.
 *
 * The working tree is compared against `origin/main` when that ref exists,
 * otherwise against a local `main`. CI checks out a single detached commit
 * with neither ref, so the workflow fetches the tip of `main` before running
 * `npm test` (see .github/workflows/ci.yml). If no base can be resolved the
 * script says so and exits 0: it must never fail the test run for reasons
 * unrelated to the changeset files themselves.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_CANDIDATES = ["origin/main", "main"];
const CHANGESET_GLOB = ".changeset/*.md";
const PACKAGE_REFERENCE = '"nansen-cli":';

const yellow = (text) => `\x1b[33m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function refExists(ref, cwd) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

/** First of BASE_CANDIDATES that resolves to a commit, or null when none does. */
export function resolveBaseRef(cwd = process.cwd()) {
  return BASE_CANDIDATES.find((ref) => refExists(ref, cwd)) ?? null;
}

/**
 * Whether the checkout is the base itself, leaving nothing to compare: either
 * `main` is the checked-out branch, or HEAD is detached at (or behind) the
 * base commit, which is how CI checks out a push to main.
 */
export function isOnBase(baseRef, cwd = process.cwd()) {
  if (git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) === "main") return true;
  try {
    git(["merge-base", "--is-ancestor", "HEAD", baseRef], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Tracked changeset files present in the working tree but absent from the base. */
export function findNewChangesets(baseRef, cwd = process.cwd()) {
  const output = git(
    ["diff", baseRef, "--name-only", "--diff-filter=A", "--", CHANGESET_GLOB],
    cwd
  );
  return output ? output.split("\n") : [];
}

/** Added, copied, modified, or renamed changesets that still exist in the working tree. */
export function findChangedChangesets(baseRef, cwd = process.cwd()) {
  const output = git(
    ["diff", baseRef, "--name-only", "--diff-filter=ACMR", "--", CHANGESET_GLOB],
    cwd
  );
  return output ? output.split("\n") : [];
}

/** Changeset files whose frontmatter does not reference this package. */
export function findInvalidChangesets(files, cwd = process.cwd()) {
  return files.filter((file) => {
    // Treat git output as untrusted input. A changeset must be a regular file
    // directly inside this checkout's .changeset directory; never follow a
    // symlink or allow an absolute/parent path to escape the repository.
    const changesetDir = resolve(cwd, ".changeset");
    const changesetPath = resolve(cwd, file);
    if (dirname(changesetPath) !== changesetDir) return true;
    const stat = lstatSync(changesetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return true;

    const frontmatter = readFileSync(changesetPath, "utf8").split("---")[1] || "";
    return !frontmatter.includes(PACKAGE_REFERENCE);
  });
}

/** Runs the check from `cwd` (the repo root) and returns the process exit code. */
export function run(cwd = process.cwd(), log = console.error) {
  try {
    const baseRef = resolveBaseRef(cwd);
    if (!baseRef) {
      log(yellow(
        `[changeset] Could not resolve a base branch (tried ${BASE_CANDIDATES.join(", ")}); skipping check.`
      ));
      return 0;
    }
    if (isOnBase(baseRef, cwd)) return 0;

    // Validate every changeset the branch leaves changed, not only additions.
    // Otherwise a modified or renamed pending changeset could name the wrong
    // package and silently skip its version bump at release time.
    const changedChangesets = findChangedChangesets(baseRef, cwd);
    const invalid = findInvalidChangesets(changedChangesets, cwd);
    for (const file of invalid) {
      log(
        red(`[changeset] ERROR: ${file} has incorrect or missing package reference.`) + "\n" +
        red('  Expected: "nansen-cli": <patch|minor|major>') + "\n" +
        red("  An invalid package name will silently skip the version bump during release.")
      );
    }
    if (invalid.length > 0) return 1;

    const newChangesets = findNewChangesets(baseRef, cwd);
    if (newChangesets.length === 0) {
      log(yellow(
        "[changeset] No new changeset file found on this branch. " +
        "If this PR changes user-facing behavior, add one: npx changeset"
      ));
      return 0;
    }

    return 0;
  } catch (err) {
    // Not a git repo, git not installed, unreadable changeset, etc. Say so
    // rather than swallowing it, but do not fail the test run over it.
    log(yellow(`[changeset] Skipping check: ${String(err.message).split("\n")[0]}`));
    return 0;
  }
}

function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = run();
