#!/usr/bin/env node

/**
 * Changeset validation script. Runs as a pretest hook.
 *
 * - Missing changeset: warning only (exit 0) — not every PR needs one.
 * - Invalid package name: hard failure (exit 1) — a wrong name silently skips
 *   the version bump during `changeset version`, breaking the release PR.
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";

try {
  const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  if (branch === "main") process.exit(0);

  const newChangesets = execSync(
    "git diff main --name-only --diff-filter=A -- .changeset/*.md",
    { encoding: "utf8" }
  ).trim();

  if (!newChangesets) {
    console.error(
      "\x1b[33m[changeset] No new changeset file found on this branch. " +
      "If this PR changes user-facing behavior, add one: npx changeset\x1b[0m"
    );
    process.exit(0);
  }

  let failed = false;
  for (const file of newChangesets.split("\n")) {
    const frontmatter = readFileSync(file, "utf8").split("---")[1] || "";
    if (!frontmatter.includes('"nansen-cli":')) {
      console.error(
        `\x1b[31m[changeset] ERROR: ${file} has incorrect or missing package reference.\x1b[0m\n` +
        `\x1b[31m  Expected: "nansen-cli": <patch|minor|major>\x1b[0m\n` +
        `\x1b[31m  An invalid package name will silently skip the version bump during release.\x1b[0m`
      );
      failed = true;
    }
  }

  if (failed) process.exit(1);
} catch {
  // Not a git repo, main doesn't exist, etc. — skip silently.
}
