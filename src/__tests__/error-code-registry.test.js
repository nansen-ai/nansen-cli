/**
 * API-1080: every error code the CLI can emit is in src/error-codes.js, and
 * docs/error-codes.md is generated from that list.
 *
 * The scan reads every non-test source file and collects the uppercase string
 * literals passed to an `...Error(` constructor, assigned to `code`, or read
 * as `ErrorCode.X`. A new code fails here until it is registered (with a
 * description), so the documented list cannot fall behind the source.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ERROR_CODES, ERROR_CODE_GROUPS, FIELD_ERROR_CODES, ErrorCode } from '../error-codes.js';
import { ErrorCode as ApiErrorCode, SERVER_CODE_MAP } from '../api.js';
import { DOC_PATH, renderErrorCodesDoc } from '../../scripts/generate-error-codes-doc.js';

const SRC = path.resolve(process.cwd(), 'src');

// Uppercase literals inside error constructors that are not error codes.
const NOT_CODES = new Set([
  'ENOENT', // errno compared against err.code, not emitted
  'EVM', // text inside a message
  'NANSEN_BASE_URL', // environment variable named in a message
]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return full.endsWith('.js') ? [full] : [];
  });
}

/** The argument text of a call that starts at `start` (just after its opening paren). */
function callArguments(source, start) {
  let depth = 1;
  let quote = null;
  let text = '';
  for (let i = start; i < source.length && depth > 0; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { text += ch + source[i + 1]; i++; continue; }
      if (ch === quote) quote = null;
      text += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (depth > 0) text += ch;
  }
  return text;
}

function emittedCodes() {
  const found = new Map();
  const add = (code, file) => {
    if (NOT_CODES.has(code)) return;
    if (!found.has(code)) found.set(code, new Set());
    found.get(code).add(path.relative(SRC, file));
  };
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith('error-codes.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/new\s+[A-Za-z]*Error\s*\(/g)) {
      const args = callArguments(source, match.index + match[0].length);
      for (const literal of args.matchAll(/'([A-Z][A-Z0-9_]{2,})'/g)) add(literal[1], file);
    }
    for (const literal of source.matchAll(/\bcode\s*[:=]\s*'([A-Z][A-Z0-9_]{2,})'/g)) add(literal[1], file);
    for (const literal of source.matchAll(/\bErrorCode\.([A-Z][A-Z0-9_]+)/g)) add(literal[1], file);
  }
  return found;
}

describe('error code registry', () => {
  it('registers every code the source emits', () => {
    const unregistered = [...emittedCodes()]
      .filter(([code]) => !Object.hasOwn(ERROR_CODES, code))
      .map(([code, files]) => `${code} (${[...files].join(', ')})`);
    expect(unregistered).toEqual([]);
  });

  it('gives every code a known group and a description', () => {
    for (const [code, entry] of Object.entries(ERROR_CODES)) {
      expect(Object.keys(ERROR_CODE_GROUPS), code).toContain(entry.group);
      expect(entry.description.length, code).toBeGreaterThan(10);
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  it('exports one ErrorCode object from both modules', () => {
    expect(ApiErrorCode).toBe(ErrorCode);
    expect(Object.keys(ErrorCode)).toEqual(Object.keys(ERROR_CODES));
  });

  it('maps every server code onto a registered code', () => {
    for (const [serverCode, cliCode] of Object.entries(SERVER_CODE_MAP)) {
      expect(Object.hasOwn(ERROR_CODES, cliCode), `${serverCode} -> ${cliCode}`).toBe(true);
    }
  });

  it('documents the API field codes', () => {
    for (const code of ['missing_field', 'unknown_field', 'invalid_field_value', 'invalid_date_format', 'value_out_of_range']) {
      expect(Object.hasOwn(FIELD_ERROR_CODES, code)).toBe(true);
    }
  });

  it('keeps docs/error-codes.md in step with the registry', () => {
    // Fix: npm run error-codes:generate
    expect(fs.readFileSync(DOC_PATH, 'utf8')).toBe(renderErrorCodesDoc());
  });
});
