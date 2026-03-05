#!/usr/bin/env node

/**
 * Non-blocking check: warns if the current branch has no new changeset file
 * compared to main. Runs as a pretest hook so agents and humans see a reminder.
 * Always exits 0 — this is a nudge, not a gate.
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
  } else {
    for (const file of newChangesets.split("\n")) {
      const frontmatter = readFileSync(file, "utf8").split("---")[1] || "";
      if (!frontmatter.includes('"nansen-cli":')) {
        console.error(
          `\x1b[33m[changeset] ${file} has incorrect or missing package reference — must use "nansen-cli"\x1b[0m`
        );
      }
    }
  }
} catch {
  // Not a git repo, main doesn't exist, etc. — skip silently.
}
