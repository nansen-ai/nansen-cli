#!/usr/bin/env bash
# PreToolUse guard (Bash matcher, gated by `if: "Bash(git *)"` in settings.json).
#
# nansen-cli is a public repo. Internal issue-tracker ticket IDs must never
# leak into branch names, commit messages, PR titles/bodies, or code/test
# comments.
#
# Blocks `git checkout -b`, `git branch -m`, and `git commit` invocations
# whose command text contains a ticket-ID-shaped token (e.g. ABC-123).
#
# Escape hatch for genuine false positives (a real term, not a ticket ID —
# e.g. SHA-256): prefix the command with SKIP_TICKET_CHECK=1.

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"

if [ -z "$cmd" ]; then
  exit 0
fi

case "$cmd" in
  *SKIP_TICKET_CHECK*)
    exit 0
    ;;
esac

case "$cmd" in
  *"git checkout -b"*|*"git branch -m"*|*"git commit"*)
    if printf '%s' "$cmd" | grep -Eq '(^|[^A-Za-z0-9])[A-Za-z]{2,6}-[0-9]{2,6}([^A-Za-z0-9]|$)'; then
      reason='Blocked: this git command appears to embed a ticket-ID-shaped token (e.g. ABC-123) into a branch name or commit. nansen-cli is public -- internal issue-tracker ticket IDs must never appear in branch names, commit messages, PR titles/bodies, or code/test comments. Rename the branch / rewrite the message without the ticket ID instead. Genuine false positive (a real term, not a ticket ID, e.g. SHA-256)? Prefix the command with SKIP_TICKET_CHECK=1 to bypass once.'
      jq -n --arg reason "$reason" '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
      exit 0
    fi
    ;;
esac

exit 0
