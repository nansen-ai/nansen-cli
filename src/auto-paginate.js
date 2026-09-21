/**
 * Nansen CLI - transparent multi-page traversal (--paginate / --all)
 *
 * Every list command already sends `pagination: { page, per_page }` through
 * NansenAPI.request(). Wrapping that one method walks the pages for all of
 * them at once, so no handler needs to know about traversal. Non-list
 * requests (no `pagination` key in the body) pass straight through.
 */

import { aggregatePaginatedResponseMeta } from './response-meta.js';

export const DEFAULT_MAX_PAGES = 10;
// Rows and their serialized de-duplication keys stay resident until traversal
// completes. Keep an explicit ceiling so a typo cannot request effectively
// unbounded memory and billed API work from a long-running agent.
export const MAX_PAGES_LIMIT = 1000;

// Where list endpoints keep their rows. Mirrors formatTable/formatStream in cli.js.
export function locateRows(page, { descriptive = false } = {}) {
  if (Array.isArray(page)) return { rows: page, rebuild: rows => ({ data: rows }) };
  if (Array.isArray(page?.data)) return { rows: page.data, rebuild: rows => ({ ...page, data: rows }) };
  if (Array.isArray(page?.results)) return { rows: page.results, rebuild: rows => ({ ...page, results: rows }) };
  if (Array.isArray(page?.data?.data)) {
    return {
      rows: page.data.data,
      rebuild: rows => {
        const data = { ...page.data, data: rows };
        // The traversal summary is canonical at the top level. Keeping the
        // first page's nested pagination would expose stale next-page state.
        delete data.pagination;
        return { ...page, data };
      },
    };
  }
  if (Array.isArray(page?.data?.results)) {
    return {
      rows: page.data.results,
      rebuild: rows => {
        const data = { ...page.data, results: rows };
        delete data.pagination;
        return { ...page, data };
      },
    };
  }

  // Older endpoints use a descriptive top-level key (`trades`, `holdings`,
  // `balances`, etc.) rather than `data`. A single array is unambiguous; do
  // not guess when an envelope contains several independent arrays.
  if (descriptive && page && typeof page === 'object' && page.success !== false) {
    const arrays = Object.entries(page).filter(([, value]) => Array.isArray(value));
    if (arrays.length === 1) {
      const [key, rows] = arrays[0];
      return { rows, rebuild: mergedRows => ({ ...page, [key]: mergedRows }) };
    }
  }
  return null;
}

function locatePagination(page) {
  if (page?.pagination && typeof page.pagination === 'object') return page.pagination;
  if (page?.data?.pagination && typeof page.data.pagination === 'object') return page.data.pagination;
  return null;
}

function numericMetadata(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(value);
}

/**
 * Fetch pages starting at `pagination.page` (default 1) until one of:
 *   - a page is empty or shorter than the page size (last page),
 *   - the server's pagination metadata says the traversal is complete,
 *   - a page adds no new rows (server ignored `page` / repeated cursor),
 *   - `maxPages` requests have been made (result marked `complete: false`).
 * Rows are de-duplicated by JSON identity so overlapping pages never repeat an
 * item. Returns the first page's envelope with the merged rows and a
 * `pagination` summary: { page, pages_fetched, next_page, complete, ...server fields }.
 * A first page with no recognisable rows array is returned unchanged.
 */
export async function collectPages(fetchPage, pagination, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
    throw new RangeError(`maxPages must be a safe integer between 1 and ${MAX_PAGES_LIMIT}`);
  }
  const startPage = Math.max(1, Number(pagination?.page) || 1);
  // The page size is learned from the first page when --limit is absent;
  // a short page then means "last page". Endpoints that ignore `page` return
  // the same rows again and stop on the duplicate check instead.
  let pageSize = pagination?.per_page;
  const seen = new Set();
  const rows = [];
  let first;
  let page = startPage;
  let pagesFetched = 0;
  let complete = false;
  let firstPagination;

  while (pagesFetched < maxPages) {
    const res = await fetchPage({ ...pagination, page });
    pagesFetched++;
    const located = locateRows(res, { descriptive: true });
    if (first === undefined) {
      if (!located) return res;
      first = located;
      firstPagination = locatePagination(res);
    }
    // A later HTTP-200 response with an unexpected shape is not proof that
    // traversal completed. Return the rows collected so far as incomplete and
    // leave next_page on this page so callers can investigate or resume.
    if (!located) { complete = false; break; }

    let fresh = 0;
    for (const row of located.rows) {
      const key = JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      fresh++;
    }
    // Page size is a property of the server response, so learn it from the raw
    // row count rather than `fresh` (the de-duplicated count). An all-duplicate
    // page still stops immediately via fresh === 0 below.
    if (pageSize === undefined) pageSize = located.rows.length;

    const serverPagination = locatePagination(res);
    const totalPages = numericMetadata(serverPagination?.total_pages);
    const totalRows = numericMetadata(serverPagination?.total);
    const serverPageSize = numericMetadata(serverPagination?.per_page);
    const effectivePageSize = Number.isInteger(serverPageSize) && serverPageSize > 0
      ? serverPageSize
      : pageSize;
    const serverSaysComplete = serverPagination?.is_last_page === true
      || serverPagination?.has_more === false
      || (Object.hasOwn(serverPagination || {}, 'next_page') && serverPagination.next_page === null)
      || (Number.isInteger(totalRows) && effectivePageSize > 0 && page * effectivePageSize >= totalRows);
    const lastPage = located.rows.length === 0
      || fresh === 0
      || located.rows.length < effectivePageSize
      || serverSaysComplete
      || (Number.isInteger(totalPages) && page >= totalPages);
    if (lastPage) { complete = true; break; }
    page++;
  }

  const merged = first.rebuild(rows);
  merged.pagination = {
    ...(firstPagination || {}),
    page: startPage,
    pages_fetched: pagesFetched,
    next_page: complete ? null : page,
    complete,
  };
  return merged;
}

/**
 * Make `api.request` traverse pages for list bodies. Returns the same
 * instance. NansenAPI never calls request() recursively (x402 retries use
 * fetch() directly), so the override cannot nest.
 */
export function enableAutoPagination(api, opts = {}) {
  if (typeof api?.request !== 'function') return api;
  const request = api.request.bind(api);
  api.request = async (endpoint, body = {}, options = {}) => {
    api.paginatedResponseMeta = null;
    if (!body || typeof body !== 'object' || !('pagination' in body)) return request(endpoint, body, options);

    const pageMetadata = [];
    const result = await collectPages(async pagination => {
      const pageResult = await request(endpoint, { ...body, pagination }, options);
      pageMetadata.push({
        cached: api.servedFromCache === true,
        meta: api.servedFromCache === true ? null : api.lastResponseMeta,
      });
      return pageResult;
    }, body.pagination, opts);
    api.paginatedResponseMeta = aggregatePaginatedResponseMeta(pageMetadata);
    return result;
  };
  return api;
}
