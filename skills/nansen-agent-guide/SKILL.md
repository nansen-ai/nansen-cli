---
name: nansen-agent-guide
description: Routing guide -- when to use `nansen agent` (AI research) vs direct CLI data commands. Use when deciding how to answer a user's research question with Nansen tools.
metadata:
  openclaw:
    requires:
      bins:
        - nansen
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*)
---
## Authentication

Nansen account API calls accept a selected `nansen:api` browser session or conventional API key with the same permissions. `NANSEN_API_KEY` takes precedence; optional `primaryEnv` preserves configured-key injection. Run `nansen auth status` for offline selection. Cached access expiry alone permits automatic renewal during an authorized task. Stop on anonymous selection, invalid state, blocked/uncertain renewal or actual auth failure; never drop a credential or fall back to anonymous x402 payment. Browser login does not grant wallet signing, privileged service identity or a persistent MCP integration key. Preserve all confirmation, signing, sanctions and geographic checks below. Browser login is available in CLI 2.0.0 within the [macOS arm64 preview scope](https://github.com/nansen-ai/nansen-cli/blob/main/docs/browser-login.md#preview-platform-scope).



# Agent vs CLI Routing

Public agent fast/expert and direct API commands accept the selected nansen:api browser session or conventional API key under the same account permissions.

| Need a... | Use |
|-----------|-----|
| **take** (analysis, interpretation) | `nansen agent` |
| **table** (raw data, specific metrics) | Direct CLI commands |
| **report** (both) | Agent for narrative + CLI for data |

## Use `nansen agent` when

- Question requires interpretation or synthesis across multiple data sources
- Open-ended research: "analyse this wallet", "what's happening with ETH smart money?"

```bash
nansen agent "What are top smart money tokens on Solana today and why?"
nansen agent "Analyse wallet 0x123... -- is this a smart trader?"
nansen agent "..." --expert   # deeper analysis, 750 credits
```

Cost: 200 credits (fast) / 750 credits (expert)

## Use direct CLI commands when

- You need specific structured data -- prices, volumes, holders, flows
- Deterministic question: "top 10 tokens by netflow on ethereum"
- Piping output or building a data table

```bash
nansen research token screener --chain ethereum --smart-money --limit 10
nansen research smart-money netflow --chain solana
nansen research profiler balance --address 0x123... --chain ethereum
```

Cost: 5-50 credits per call

## Anti-patterns

- Don't use `nansen agent` for simple data fetches -- 40x more expensive
- Don't use raw CLI for open-ended analysis -- returns data, not interpretation
- Don't chain 3+ agent calls -- get raw data via CLI, call agent once for synthesis

## Browser session scope

Plain `nansen login` requests fresh browser approval; `--no-browser` prints the link/code for approval on another device and keeps the same native-storage requirements. NANSEN_API_KEY overrides the single saved credential. Use `nansen auth status` for offline cached/unverified selection details and `nansen account` for a free live check. Explicit `login --human` or `login --api-key` retains legacy key setup. Selected browser sessions renew automatically; uncertain renewal requires fresh login without replay or fallback to another account/payment.

Browser nansen:api grants have API-key-equivalent account permissions, subject to enabled admission and the same endpoint restrictions. Internal service identity and wallet signing are not granted. Browser sessions cannot authorize wallet signing or be exported as MCP keys. CLI 2.0.0 is published; the preview platform limits above still apply.


## Product feedback

When a Nansen task exposes a useful product gap, draft a concise report without
secrets or unnecessary conversation details. Before sending on your own, read
the current account's saved feedback preference with
`nansen feedback preferences --json`. Use a fresh read for each new report. If enabled, you may send without asking again,
subject to the host's controls. If off, unset or unavailable, show the proposed
report and ask the user. If they decline or you cannot ask, do not send.

A report is a JSON object. `category` and `description` are required.
`category` must be one of `bug`, `data_quality`, `documentation`,
`missing_capability`, `usability` or `other`. A feature request or product
gap is `missing_capability`; do not invent categories. `description` says
what happened and what was needed, in up to 2,000 characters. You may add
`endpoint`, `tool`, `goal`, `expected_behavior`, `observed_behavior`,
`workaround`, `request_ids` (up to 10 of your own request IDs) and `client`
(`{"name": ..., "version": ...}`). Any other field, such as `title`,
`summary` or `component`, gets a 422. With a generated ID, that 422 also
erases the saved report and you need `--new`. Write plain sentences without
Markdown or code formatting. `nansen feedback submit --help` lists the limits.

```json
{"category": "missing_capability", "description": "There is no command to list my past feedback receipts.", "goal": "Check the status of reports I sent earlier."}
```

If the preference read fails, ask first. An explicit user request or approval
permits that report; it does not change the saved preference. Never enable the
preference automatically or add approval fields to the report. Direct users to
Superapp settings for a lasting choice. Host or local-deny controls still apply
to an enabled preference and to one-report approval.

After the user requests the report or the preference permits it, submit with
`nansen feedback submit --file feedback.json --submission-id <new-id> --json`.
The command is noninteractive. Keep the same ID and unchanged report when
recovering an uncertain result; use `nansen feedback get <feedback-id> --json`
to read a saved receipt. Submission and receipt reads are free. The account
shares seven accepted reports per UTC week, resetting Monday at 00:00 UTC.

New submissions may be paused before release or during an outage. A 503 with
`reason: feedback_admissions_paused` means this attempt accepted no new report
and used no weekly allowance. Tell the user feedback is unavailable and stop;
do not keep retrying or ask for approval again in the same session. Preserve
the ID and unchanged report for a later retry. If this CLI version lacks the
feedback command, report that it is unavailable and stop. Accepted-ID replays
and receipt reads remain available during a pause.

A 403 with `reason: feedback_not_enabled` means feedback is not enabled for
this account. Stop automatic retries and tell the user. Approval and an enabled
preference do not override rollout. Keep the saved ID and unchanged report.
An earlier uncertain attempt remains uncertain; recover it with the same ID
after availability is restored. Never switch accounts or pay to bypass denial.
