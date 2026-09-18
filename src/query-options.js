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
  const parts = String(sortOption).split(':');
  const field = parts[0].trim();
  const direction = (parts[1] || 'desc').trim().toUpperCase();
  if (!field) {
    throw new NansenError('--sort needs a field name, e.g. --sort value_usd:desc', ErrorCode.INVALID_PARAMS);
  }
  if (direction !== 'ASC' && direction !== 'DESC') {
    throw new NansenError(
      `--sort direction must be asc or desc, got "${parts[1]}" (e.g. --sort ${field}:desc)`,
      ErrorCode.INVALID_PARAMS,
    );
  }
  return [{ field, direction }];
}

/**
 * Normalise a comma-separated-string-or-array CLI option into an array of
 * strings, or undefined if absent. Accepts either a single "a,b,c" string or
 * an array (parseArgs collects repeated flags, e.g. `--tag a --tag b`, into
 * one), and rejects non-string values/elements (e.g. `--flag true` is
 * parsed by parseArgs as the JSON boolean `true`) with an actionable
 * INVALID_PARAMS error instead of crashing on .split()/.trim().
 */
export function parseCsvOption(val, name) {
  if (val === undefined || val === '') return undefined;
  if (Array.isArray(val)) {
    if (!val.every(v => typeof v === 'string')) {
      throw new NansenError(`--${name} values must be strings`, ErrorCode.INVALID_PARAMS);
    }
    return val.map(v => v.trim()).filter(Boolean);
  }
  if (typeof val !== 'string') {
    throw new NansenError(`--${name} must be a string`, ErrorCode.INVALID_PARAMS);
  }
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

/** Reject explicit blank strings before a handler selects an omitted-option default. */
export function rejectBlankOption(value, name, example) {
  if (typeof value === 'string' && value.trim() === '') {
    throw new CommandError(`--${name} requires a value. Usage: --${name} ${example}`, 'MISSING_PARAM');
  }
}
