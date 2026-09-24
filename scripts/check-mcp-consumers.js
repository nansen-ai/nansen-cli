#!/usr/bin/env node

/**
 * Report whether public consumers of src/mcp-client-config.json vendor the
 * current file (API-322). Today that is nansen-ai/nansen-mcp-dxt. The docs
 * source runs its own check.
 *
 * Exit codes: 0 = in sync, 3 = a consumer pins a different file, 2 = the check failed.
 * .github/workflows/mcp-remote-pin.yml runs this weekly next to the pin check,
 * because a scheduled job in a quiet public repo can be disabled by GitHub.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MCP_CLIENT_CONFIG_PATH } from '../src/mcp-client-config.js';

export const CONSUMERS = Object.freeze([
  { name: 'nansen-ai/nansen-mcp-dxt', upstreamJson: 'https://raw.githubusercontent.com/nansen-ai/nansen-mcp-dxt/main/config/upstream.json', sync: 'npm run sync -- --ref <sha>' },
]);

// Same shape as check-mcp-remote-pin.js: argv first (no flags yet), then injectable I/O for tests.
export async function run(_argv = [], { fetchFn = fetch, log = console.log, error = console.error, localBytes } = {}) {
  try {
    const local = createHash('sha256').update(localBytes ?? fs.readFileSync(MCP_CLIENT_CONFIG_PATH)).digest('hex');
    let stale = 0;
    for (const consumer of CONSUMERS) {
      const response = await fetchFn(consumer.upstreamJson, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`GET ${consumer.upstreamJson} returned HTTP ${response.status}`);
      const pinned = await response.json();
      // These values go into a GitHub issue code block: accept only hex.
      const sha = /^[0-9a-f]{64}$/.test(pinned?.sha256 ?? '') ? pinned.sha256 : '<invalid>';
      const ref = /^[0-9a-f]{40}$/.test(pinned?.ref ?? '') ? pinned.ref : '<invalid>';
      if (sha === local) {
        log(`${consumer.name}: in sync (ref ${ref.slice(0, 12)})`);
      } else {
        stale += 1;
        log(`${consumer.name}: OUT OF SYNC - it pins sha256 ${sha} at ref ${ref}; this repo has ${local}. In ${consumer.name}, run: ${consumer.sync}`);
      }
    }
    return stale ? 3 : 0;
  } catch (err) {
    error(`consumer check failed: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2));
}
