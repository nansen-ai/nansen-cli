#!/usr/bin/env node

/**
 * Generate docs/error-codes.md from src/error-codes.js (API-1080).
 *
 *   npm run error-codes:generate   rewrite docs/error-codes.md
 *   npm run error-codes:check      exit 1 if docs/error-codes.md is stale
 *
 * The page is a pure function of the registry, so edit src/error-codes.js and
 * regenerate; never edit the page by hand. `npm test` also fails when it is
 * stale (src/__tests__/error-code-registry.test.js).
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, ERROR_CODE_GROUPS, FIELD_ERROR_CODES } from '../src/error-codes.js';

export const DOC_PATH = fileURLToPath(new URL('../docs/error-codes.md', import.meta.url));

// Escape backslashes first, then pipes, so a description cannot end a cell or
// turn the escape of a pipe into a literal backslash.
const cell = text => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

export function renderErrorCodesDoc() {
  const lines = [
    '<!-- Generated from src/error-codes.js by scripts/generate-error-codes-doc.js. Do not edit by hand; run: npm run error-codes:generate -->',
    '',
    '# Error codes',
    '',
    'Every failure exits with a non-zero status and prints one JSON envelope on stdout (with `--table` or `--format csv`, the same fields as text or CSV):',
    '',
    '```json',
    '{',
    '  "success": false,',
    '  "error": "Option \'--timefrme\' is not recognized by nansen research token info. Did you mean \'--timeframe\'?",',
    '  "code": "INVALID_PARAMS",',
    '  "status": null,',
    '  "details": {',
    '    "param": "--timefrme",',
    '    "errors": [',
    '      { "field": "--timefrme", "message": "Option \'--timefrme\' is not recognized by nansen research token info. Did you mean \'--timeframe\'?", "code": "unknown_field" }',
    '    ]',
    '  }',
    '}',
    '```',
    '',
    '- `error` is the message. It is not repeated inside `details`.',
    '- `code` is one of the codes below. Branch on it, not on the message.',
    '- `status` is the HTTP status for an API error and `null` for a local error.',
    '- `requestId` is present when the API returned one. Quote it to support.',
    '- `details` carries the API\'s error body (for example `code`, `param`, `errors`, `doc_url`) or, for a local check, `param` and `errors`.',
    '- `details.errors[]` lists each bad field or option as `{ field, message, code }`. For an API error, `field` is the request field (for example `body.chain`); for a local check, it is the option (for example `--chain`).',
    '',
    'One exception: in an interactive terminal without `--pretty`, `--table`, `--format` or `--stream`, a local usage error (`MISSING_PARAM` or `MISSING_ARGS`) prints only its message. The exit status is still non-zero. Piped output always gets the envelope.',
    '',
    'A connection failure is `NETWORK_ERROR` and never `UNAUTHORIZED`: the CLI could not reach the API, so it did not check the credential. Fix the connection; do not replace the API key.',
    '',
    '## Codes',
    '',
  ];
  for (const [group, heading] of Object.entries(ERROR_CODE_GROUPS)) {
    const entries = Object.entries(ERROR_CODES).filter(([, entry]) => entry.group === group);
    if (!entries.length) continue;
    lines.push(`### ${heading}`, '', '| Code | Meaning | Retry |', '| --- | --- | --- |');
    for (const [code, entry] of entries) {
      lines.push(`| \`${code}\` | ${cell(entry.description)} | ${entry.retry ? 'Yes' : 'No'} |`);
    }
    lines.push('');
  }
  lines.push(
    '## Field codes',
    '',
    '`details.errors[].code` uses the API\'s field-level codes ([API error handling](https://docs.nansen.ai/getting-started/error-handling)). The CLI uses the same codes for its own checks, so one bad field reads the same from the CLI, the REST API and the MCP server.',
    '',
    '| Field code | Meaning |',
    '| --- | --- |',
  );
  for (const [code, description] of Object.entries(FIELD_ERROR_CODES)) {
    lines.push(`| \`${code}\` | ${cell(description)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function main(argv) {
  const expected = renderErrorCodesDoc();
  if (argv.includes('--check')) {
    const current = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';
    if (current !== expected) {
      console.error('docs/error-codes.md is stale. Run: npm run error-codes:generate');
      return 1;
    }
    console.log('docs/error-codes.md is current.');
    return 0;
  }
  fs.writeFileSync(DOC_PATH, expected);
  console.log(`Wrote ${DOC_PATH}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
