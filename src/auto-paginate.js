/**
 * Nansen CLI - transparent multi-page traversal (--paginate / --all)
 *
 * Every list command already sends `pagination: { page, per_page }` through
 * NansenAPI.request(). Wrapping that one method walks the pages for all of
 * them at once, so no handler needs to know about traversal. Non-list
 * requests (no `pagination` key in the body) pass straight through.
 */

export const DEFAULT_MAX_PAGES = 10;

// Where list endpoints keep their rows. Mirrors formatTable/formatStream in cli.js.
function locateRows(page) {
  if (Array.isArray(page)) return { rows: page, rebuild: rows => ({ data: rows }) };
  if (Array.isArray(page?.data)) return { rows: page.data, rebuild: rows => ({ ...page, data: rows }) };
  if (Array.isArray(page?.results)) return { rows: page.results, rebuild: rows => ({ ...page, results: rows }) };
  if (Array.isArray(page?.data?.data)) {
    return { rows: page.data.data, rebuild: rows => ({ ...page, data: { ...page.data, data: rows } }) };
  }
  if (Array.isArray(page?.data?.results)) {
    return { rows: page.data.results, rebuild: rows => ({ ...page, data: { ...page.data, results: rows } }) };
  }
  return null;
}

/**
 * Fetch pages starting at `pagination.page` (default 1) until one of:
 *   - a page is empty or shorter than the page size (last page),
 *   - the server's `pagination.total_pages` is reached,
 *   - a page adds no new rows (server ignored `page` / repeated cursor),
 *   - `maxPages` requests have been made (result marked `complete: false`).
 * Rows are de-duplicated by JSON identity so overlapping pages never repeat an
 * item. Returns the first page's envelope with the merged rows and a
 * `pagination` summary: { page, pages_fetched, next_page, complete, ...server fields }.
 * A first page with no recognisable rows array is returned unchanged.
 */
export async function collectPages(fetchPage, pagination, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const startPage = Math.max(1, Number(pagination?.page) || 1);
  // ponytail: page size is learned from the first page when --limit is absent;
  // a short page then means "last page". Endpoints that ignore `page` return
  // the same rows again and stop on the duplicate check instead.
  let pageSize = pagination?.per_page;
  const seen = new Set();
  const rows = [];
  let first;
  let page = startPage;
  let pagesFetched = 0;
  let complete = false;

  while (pagesFetched < maxPages) {
    const res = await fetchPage({ ...pagination, page });
    pagesFetched++;
    const located = locateRows(res);
    if (first === undefined) {
      if (!located) return res;
      first = located;
    }
    if (!located) { complete = true; break; }

    let fresh = 0;
    for (const row of located.rows) {
      const key = JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      fresh++;
    }
    if (pageSize === undefined) pageSize = located.rows.length;

    const totalPages = Number(res?.pagination?.total_pages);
    const lastPage = located.rows.length === 0
      || fresh === 0
      || located.rows.length < pageSize
      || (Number.isInteger(totalPages) && page >= totalPages);
    if (lastPage) { complete = true; break; }
    page++;
  }

  const merged = first.rebuild(rows);
  merged.pagination = {
    ...(merged.pagination && typeof merged.pagination === 'object' ? merged.pagination : {}),
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
  api.request = (endpoint, body = {}, options = {}) => {
    if (!body || typeof body !== 'object' || !('pagination' in body)) return request(endpoint, body, options);
    return collectPages(pagination => request(endpoint, { ...body, pagination }, options), body.pagination, opts);
  };
  return api;
}
