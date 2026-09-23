/**
 * Nansen CLI - Shared list-query helpers
 *
 * Builds pagination and order_by request fragments from CLI options.
 * Lives in a leaf module so src/cli.js and src/commands/*.js share one
 * implementation without circular imports.
 */

import { NansenError, CommandError, ErrorCode } from './api.js';

export function buildPagination(options) {
  if (options.limit === undefined && options.page === undefined) return undefined;
  const perPage = options.limit === undefined ? undefined : Number(options.limit);
  if (perPage !== undefined && (!Number.isInteger(perPage) || perPage < 1)) {
    throw new NansenError('--limit must be a positive integer', ErrorCode.INVALID_PARAMS);
  }
  return {
    page: Math.max(1, parseInt(options.page, 10) || 1),
    per_page: perPage,
  };
}

// Parse simple sort syntax: "field:direction" or "field" (defaults to DESC)
export function parseSort(sortOption, orderByOption) {
  // If --order-by is provided, use it (full JSON control)
  if (orderByOption) return orderByOption;
  if (!sortOption) return undefined;
  if (typeof sortOption !== 'string') {
    throw new NansenError('--sort must be "field" or "field:direction"', ErrorCode.INVALID_PARAMS);
  }
  const parts = sortOption.split(':');
  const field = parts[0].trim();
  const rawDirection = (parts[1] || '').trim();
  const direction = (rawDirection || 'desc').toUpperCase();
  if (!field) {
    throw new NansenError('--sort needs a field name, e.g. --sort value_usd:desc', ErrorCode.INVALID_PARAMS);
  }
  if (direction !== 'ASC' && direction !== 'DESC') {
    throw new NansenError(
      `--sort direction must be asc or desc, got "${rawDirection}" (e.g. --sort ${field}:desc)`,
      ErrorCode.INVALID_PARAMS,
    );
  }
  return [{ field, direction }];
}

/**
 * Normalise a comma-separated-string-or-array CLI option into an array of
 * strings, or undefined if absent. Accepts either a single "a,b,c" string or
 * an array (parseArgs collects repeated flags, e.g. `--tag a --tag b`, into
 * one), and rejects non-string values/elements (e.g. `--flag '{}'` is
 * parsed by parseArgs as a JSON object) with an actionable
 * INVALID_PARAMS error instead of crashing on .split()/.trim().
 */
export function parseCsvOption(val, name) {
  if (val === undefined || val === '') return undefined;
  if (Array.isArray(val)) {
    if (!val.every(v => typeof v === 'string')) {
      throw new NansenError(`--${name} values must be strings`, ErrorCode.INVALID_PARAMS);
    }
    // A repeated flag may itself carry a list (`--tags defi,nft --tags sports`),
    // so split each element the same way a single value is split.
    return val.flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean);
  }
  if (typeof val !== 'string') {
    throw new NansenError(`--${name} must be a string`, ErrorCode.INVALID_PARAMS);
  }
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Normalise a `--filters '<json>'` option into a plain object, or `{}` when
 * absent. parseArgs already JSON-parses the value, so anything that is not a
 * plain object here (`--filters '[]'`, `--filters abc`, a repeated flag) would
 * otherwise go straight into the request body and fail upstream with a 422.
 */
export function parseObjectOption(val, name) {
  if (val === undefined || val === '') return {};
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    throw new NansenError(
      `--${name} must be a JSON object, e.g. --${name} '{"key": "value"}'`,
      ErrorCode.INVALID_PARAMS,
    );
  }
  return val;
}

/** Reject explicit blank strings before a handler selects an omitted-option default. */
export function rejectBlankOption(value, name, example) {
  if (typeof value === 'string' && value.trim() === '') {
    throw new CommandError(`--${name} requires a value. Usage: --${name} ${example}`, 'MISSING_PARAM');
  }
}
