/**
 * Nansen CLI - transparent multi-page traversal (--paginate / --all)
 *
 * Every list command already sends `pagination: { page, per_page }` through
 * NansenAPI.request(). Wrapping that one method walks the pages for all of
 * them at once, so no handler needs to know about traversal. Non-list
 * requests (no `pagination` key in the body) pass straight through.
 */

import { aggregatePaginatedResponseMeta } from './response-meta.js';
import { ErrorCode, NansenError, RESPONSE_META } from './api.js';

export const DEFAULT_MAX_PAGES = 10;
// Rows and their serialized de-duplication keys stay resident until traversal
// completes. Keep an explicit ceiling so a typo cannot request effectively
// unbounded memory and billed API work from a long-running agent.
export const MAX_PAGES_LIMIT = 1000;

// Shared by collectPages and cli.js's formatTable/formatCsv/formatStream so
// pagination and output formatting recognise the same row shapes.
export function locateRows(page, { descriptive = false } = {}) {
  if (page?.success === false) return null;
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
  // not count pagination metadata as rows or guess when an envelope contains
  // several independent data arrays.
  if (descriptive && page && typeof page === 'object') {
    const arrays = Object.entries(page)
      .filter(([key, value]) => key !== 'pagination' && Array.isArray(value));
    if (arrays.length === 1) {
      const [key, rows] = arrays[0];
      return { rows, rebuild: mergedRows => ({ ...page, [key]: mergedRows }) };
    }
  }
  return null;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function locatePagination(page) {
  if (isPlainObject(page?.pagination)) return page.pagination;
  if (isPlainObject(page?.data?.pagination)) return page.data.pagination;
  return null;
}

function numericMetadata(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(value);
}

function failedPageError(response, page) {
  const nested = response?.error && typeof response.error === 'object'
    ? response.error
    : null;
  const message = typeof response?.error === 'string'
    ? response.error
    : nested?.message || response?.message || `Pagination request failed on page ${page}`;
  const code = response?.code || nested?.code || ErrorCode.UNKNOWN;
  const status = response?.status ?? nested?.status ?? null;
  const details = response?.details ?? nested?.details ?? response?.data ?? null;
  return new NansenError(message, code, status, details);
}

function canonicalRowKey(value) {
  // TODO: Consider a streaming hash only if bounded MAX_PAGES traversals show
  // material memory pressure; canonical strings keep identity deterministic.
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array:[${value.map(canonicalRowKey).join(',')}]`;
  if (isPlainObject(value)) {
    return `object:{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalRowKey(value[key])}`
    )).join(',')}}`;
  }
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value === 'number' && Object.is(value, -0)) return 'number:-0';
  return `${typeof value}:${JSON.stringify(value)}`;
}

/**
 * Fetch pages starting at `pagination.page` (default 1) until one of:
 *   - a page is empty or shorter than the page size (last page),
 *   - the server's pagination metadata says the traversal is complete,
 *   - a page adds no new rows (server ignored `page` / repeated cursor),
 *   - `maxPages` requests have been made (result marked `complete: false`).
 * Rows are de-duplicated by canonical JSON identity (object keys are sorted
 * recursively) so overlapping pages never repeat a semantically equal item.
 * Returns the first page's envelope with the merged rows and a
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
    if (res?.success === false) throw failedPageError(res, page);
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
      const key = canonicalRowKey(row);
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
      // Pages are 1-based, so page * size is the current page's inclusive row
      // endpoint. Trust the server total to avoid a separately billed empty
      // probe; inconsistent total metadata can therefore cause an under-fetch.
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
  let traversalQueue = Promise.resolve();
  api.request = async (endpoint, body = {}, options = {}) => {
    if (options.autoPaginate === false
      || !body || typeof body !== 'object' || !('pagination' in body)) {
      return request(endpoint, body, options);
    }

    const traverse = async () => {
      // Only a new traversal supersedes the previous aggregate. Auxiliary
      // non-list requests may run afterward and must not erase its credit scope.
      api.paginatedResponseMeta = null;
      api.paginatedEndpoint = null;
      const pageMetadata = [];
      const recordPageMetadata = (meta, cached = false) => {
        pageMetadata.push({ cached, meta: cached ? null : meta });
      };
      try {
        return await collectPages(async pagination => {
          const previousMeta = api.lastResponseMeta;
          try {
            const pageResult = await request(endpoint, { ...body, pagination }, options);
            // The payload belongs to this exact request, unlike the instance's
            // last-* fields which concurrent non-list calls can overwrite.
            const cached = pageResult?._meta?.fromCache === true
              || (api.responseMetadataOnPayload !== true && api.servedFromCache === true);
            const payloadMeta = pageResult?.[RESPONSE_META];
            const meta = payloadMeta ?? (
              api.responseMetadataOnPayload === true ? null : api.lastResponseMeta
            );
            recordPageMetadata(meta, cached);
            return pageResult;
          } catch (error) {
            const details = error?.details;
            const errorMeta = details && typeof details === 'object'
              ? {
                  ...(details.requestId && { requestId: details.requestId }),
                  ...(details.credits && { credits: details.credits }),
                  ...(details.rateLimit && { rateLimit: details.rateLimit }),
                }
              : null;
            const hasErrorMeta = errorMeta && Object.keys(errorMeta).length > 0;
            // A transport failure may leave the prior page's metadata in place;
            // count the attempt, but only use shared state when the error itself
            // carries no metadata and this request demonstrably replaced it.
            recordPageMetadata(hasErrorMeta
              ? errorMeta
              : (api.lastResponseMeta === previousMeta ? null : api.lastResponseMeta));
            throw error;
          }
        }, body.pagination, opts);
      } finally {
        api.paginatedResponseMeta = aggregatePaginatedResponseMeta(pageMetadata);
        api.paginatedEndpoint = endpoint;
      }
    };

    // Shared instance metadata has one command-level slot. Serialize only
    // traversals so two callers cannot interleave pages and overwrite it;
    // ordinary and explicitly bypassed requests remain direct.
    const pending = traversalQueue.then(traverse, traverse);
    traversalQueue = pending.catch(() => {});
    return pending;
  };
  return api;
}
