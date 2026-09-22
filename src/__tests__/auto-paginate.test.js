import { describe, it, expect, vi } from 'vitest';
import { collectPages, enableAutoPagination, DEFAULT_MAX_PAGES, locateRows } from '../auto-paginate.js';

// Server with `total` rows of `size` per page under `{ data: [...] }`.
function server(total, size, extra = {}) {
  return vi.fn(async ({ page }) => {
    const start = (page - 1) * size;
    return { ...extra, data: Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => ({ id: start + i })) };
  });
}

describe('locateRows descriptive envelopes', () => {
  it.each([
    ['top-level data', { success: false, error: 'bad', data: [] }],
    ['top-level results', { success: false, error: 'bad', results: [] }],
    ['nested data', { success: false, error: 'bad', data: { data: [] } }],
    ['nested results', { success: false, error: 'bad', data: { results: [] } }],
  ])('rejects a failed %s envelope before inspecting row arrays', (_name, page) => {
    expect(locateRows(page, { descriptive: true })).toBeNull();
  });

  it('does not treat a pagination-only array as row data', () => {
    expect(locateRows({ pagination: [{ page: 1 }] }, { descriptive: true })).toBeNull();
  });

  it('ignores an array-valued pagination key when one real data array exists', () => {
    const page = { trades: [{ id: 1 }], pagination: [{ page: 1 }] };
    const located = locateRows(page, { descriptive: true });

    expect(located.rows).toEqual(page.trades);
    expect(located.rebuild([{ id: 2 }])).toEqual({
      trades: [{ id: 2 }],
      pagination: page.pagination,
    });
  });

  it('keeps multiple real top-level arrays ambiguous', () => {
    expect(locateRows({
      trades: [{ id: 1 }],
      holdings: [{ id: 2 }],
      pagination: [{ page: 1 }],
    }, { descriptive: true })).toBeNull();
  });
});

describe('collectPages', () => {
  it.each([0, -1, 1.5, 1001, Number.MAX_SAFE_INTEGER])(
    'rejects an unsafe direct maxPages value: %s',
    async (maxPages) => {
      const fetchPage = server(1, 1);
      await expect(collectPages(fetchPage, { page: 1, per_page: 1 }, { maxPages }))
        .rejects.toThrow(/maxPages must be a safe integer between 1 and 1000/);
      expect(fetchPage).not.toHaveBeenCalled();
    },
  );

  it('walks until a short page and merges rows in order', async () => {
    const fetchPage = server(25, 10);
    const res = await collectPages(fetchPage, { page: 1, per_page: 10 });
    expect(res.data.map(r => r.id)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls.map(c => c[0])).toEqual([
      { page: 1, per_page: 10 }, { page: 2, per_page: 10 }, { page: 3, per_page: 10 },
    ]);
    expect(res.pagination).toEqual({ page: 1, pages_fetched: 3, next_page: null, complete: true });
  });

  it('stops on an empty page when the last page was full', async () => {
    const fetchPage = server(20, 10);
    const res = await collectPages(fetchPage, { page: 1, per_page: 10 });
    expect(res.data).toHaveLength(20);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(res.pagination.complete).toBe(true);
  });

  it('learns the page size from the first page when per_page is absent', async () => {
    const fetchPage = server(12, 5);
    const res = await collectPages(fetchPage, undefined);
    expect(res.data).toHaveLength(12);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage.mock.calls[0][0]).toEqual({ page: 1 });
  });

  it('uses the server page size for short-page detection when it differs from the request', async () => {
    const clamped = vi.fn(async ({ page }) => ({
      pagination: { page, per_page: 2 },
      data: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
    }));
    const clampedResult = await collectPages(clamped, { page: 1, per_page: 100 });
    expect(clamped).toHaveBeenCalledTimes(2);
    expect(clampedResult.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const partial = vi.fn(async () => ({
      pagination: { page: 1, per_page: 3 },
      data: [{ id: 1 }, { id: 2 }],
    }));
    const partialResult = await collectPages(partial, { page: 1 });
    expect(partial).toHaveBeenCalledTimes(1);
    expect(partialResult.pagination.complete).toBe(true);
  });

  it('honours a start page and other pagination fields', async () => {
    const fetchPage = server(25, 10);
    const res = await collectPages(fetchPage, { page: '2', per_page: 10 });
    expect(res.data.map(r => r.id)).toEqual(Array.from({ length: 15 }, (_, i) => 10 + i));
    expect(res.pagination.page).toBe(2);
  });

  it('stops at the server total_pages without an extra request', async () => {
    const fetchPage = server(20, 10, { pagination: { page: 1, per_page: 10, total_pages: 2 } });
    const res = await collectPages(fetchPage, { page: 1, per_page: 10 });
    expect(res.data).toHaveLength(20);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(res.pagination).toEqual({ page: 1, per_page: 10, total_pages: 2, pages_fetched: 2, next_page: null, complete: true });
  });

  it('honours is_last_page and total metadata without an extra billed request', async () => {
    const byLastFlag = vi.fn(async () => ({
      pagination: { page: 1, per_page: 2, is_last_page: true },
      data: [{ id: 1 }, { id: 2 }],
    }));
    const flagged = await collectPages(byLastFlag, { page: 1, per_page: 2 }, { maxPages: 1 });
    expect(byLastFlag).toHaveBeenCalledTimes(1);
    expect(flagged.pagination).toEqual({
      page: 1, per_page: 2, is_last_page: true,
      pages_fetched: 1, next_page: null, complete: true,
    });

    const byTotal = vi.fn(async () => ({
      pagination: { page: 1, per_page: 2, total: 2 },
      data: [{ id: 1 }, { id: 2 }],
    }));
    const counted = await collectPages(byTotal, { page: 1, per_page: 2 });
    expect(byTotal).toHaveBeenCalledTimes(1);
    expect(counted.pagination.complete).toBe(true);
  });

  it('uses the 1-based page endpoint when total ends exactly on start page 10', async () => {
    const fetchPage = vi.fn(async ({ page }) => ({
      data: Array.from({ length: 100 }, (_, i) => ({ id: (page - 1) * 100 + i + 1 })),
      pagination: { page, per_page: 100, total: 1000 },
    }));

    const res = await collectPages(fetchPage, { page: 10, per_page: 100 });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(res.data.map(row => row.id)).toEqual(Array.from({ length: 100 }, (_, i) => 901 + i));
    expect(res.pagination).toMatchObject({ page: 10, pages_fetched: 1, complete: true });
  });

  it('fetches page 11 from start page 10 when total extends beyond row 1000', async () => {
    const fetchPage = vi.fn(async ({ page }) => {
      const firstId = (page - 1) * 100 + 1;
      const count = Math.max(0, Math.min(100, 1050 - firstId + 1));
      return {
        data: Array.from({ length: count }, (_, i) => ({ id: firstId + i })),
        pagination: { page, per_page: 100, total: 1050 },
      };
    });

    const res = await collectPages(fetchPage, { page: 10, per_page: 100 });

    expect(fetchPage.mock.calls.map(([pagination]) => pagination.page)).toEqual([10, 11]);
    expect(res.data.map(row => row.id)).toEqual(Array.from({ length: 150 }, (_, i) => 901 + i));
    expect(res.pagination).toMatchObject({ page: 10, pages_fetched: 2, complete: true });
  });

  it('honours pagination metadata nested alongside nested data', async () => {
    const fetchPage = vi.fn(async () => ({
      data: {
        data: [{ id: 1 }, { id: 2 }],
        pagination: { page: 1, per_page: 2, total_pages: 1 },
      },
    }));
    const res = await collectPages(fetchPage, { page: 1, per_page: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(res.data.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.data.pagination).toBeUndefined();
    expect(res.pagination).toMatchObject({ total_pages: 1, pages_fetched: 1, complete: true });
  });

  it('removes stale nested pagination from a data.results envelope', async () => {
    const fetchPage = vi.fn(async () => ({
      data: {
        results: [{ id: 1 }],
        pagination: { page: 1, per_page: 1, next_page: null },
      },
    }));

    const res = await collectPages(fetchPage, { page: 1, per_page: 1 });

    expect(res.data.results).toEqual([{ id: 1 }]);
    expect(res.data.pagination).toBeUndefined();
    expect(res.pagination).toMatchObject({ page: 1, pages_fetched: 1, complete: true });
  });

  it('does not treat null totals as zero-row completion metadata', async () => {
    const fetchPage = vi.fn(async ({ page }) => ({
      pagination: { page, per_page: 2, total: null, total_pages: null },
      data: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
    }));
    const res = await collectPages(fetchPage, { page: 1, per_page: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(res.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('stops when a page repeats rows already seen (server ignoring page) and never duplicates items', async () => {
    const fetchPage = vi.fn(async () => ({ data: [{ id: 1 }, { id: 2 }] }));
    const res = await collectPages(fetchPage, { page: 1, per_page: 2 });
    expect(res.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(res.pagination.complete).toBe(true);
  });

  it('marks a partial traversal incomplete when a later page is not a list response', async () => {
    const fetchPage = vi.fn(async ({ page }) => (
      page === 1
        ? { data: [{ id: 1 }, { id: 2 }] }
        : { status: 'ok', message: 'unexpected envelope' }
    ));

    const res = await collectPages(fetchPage, { page: 1, per_page: 2 });

    expect(res.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.pagination).toMatchObject({
      pages_fetched: 2,
      next_page: 2,
      complete: false,
    });
  });

  it('drops overlapping rows across pages', async () => {
    const pages = { 1: [{ id: 1 }, { id: 2 }], 2: [{ id: 2 }, { id: 3 }], 3: [{ id: 4 }] };
    const fetchPage = vi.fn(async ({ page }) => ({ data: pages[page] }));
    const res = await collectPages(fetchPage, { page: 1, per_page: 2 });
    expect(res.data.map(r => r.id)).toEqual([1, 2, 3, 4]);
  });

  it('caps requests at maxPages and reports where to resume', async () => {
    const fetchPage = server(1000, 10);
    const res = await collectPages(fetchPage, { page: 1, per_page: 10 }, { maxPages: 3 });
    expect(res.data).toHaveLength(30);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(res.pagination).toEqual({ page: 1, pages_fetched: 3, next_page: 4, complete: false });
  });

  it('defaults to DEFAULT_MAX_PAGES', async () => {
    const fetchPage = server(1000, 10);
    const res = await collectPages(fetchPage, { page: 1, per_page: 10 });
    expect(fetchPage).toHaveBeenCalledTimes(DEFAULT_MAX_PAGES);
    expect(res.pagination.next_page).toBe(DEFAULT_MAX_PAGES + 1);
  });

  it('wraps bare-array pages as { data } and preserves nested { data: { data } } shapes', async () => {
    const bare = vi.fn(async ({ page }) => (page === 1 ? [{ id: 1 }] : []));
    expect(await collectPages(bare, { page: 1, per_page: 1 })).toEqual({
      data: [{ id: 1 }], pagination: { page: 1, pages_fetched: 2, next_page: null, complete: true },
    });

    const nested = vi.fn(async ({ page }) => ({ meta: 'x', data: { total: 3, data: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] } }));
    const res = await collectPages(nested, { page: 1, per_page: 2 });
    expect(res.meta).toBe('x');
    expect(res.data.total).toBe(3);
    expect(res.data.data.map(r => r.id)).toEqual([1, 2, 3]);
  });

  it.each([
    ['top-level', rows => ({ data: rows, pagination: [{ total_pages: 1 }] })],
    ['nested', rows => ({ data: { data: rows, pagination: [{ total_pages: 1 }] } })],
  ])('ignores array-valued %s pagination metadata without leaking numeric keys', async (_shape, response) => {
    const fetchPage = vi.fn(async ({ page }) => response(
      page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
    ));

    const res = await collectPages(fetchPage, { page: 1, per_page: 2 });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(res.data?.data || res.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(res.pagination).toEqual({
      page: 1,
      pages_fetched: 2,
      next_page: null,
      complete: true,
    });
    expect(res.pagination).not.toHaveProperty('0');
    expect(res.data?.pagination).toBeUndefined();
  });

  it('merges an unambiguous descriptive top-level list key', async () => {
    const fetchPage = vi.fn(async ({ page }) => ({
      pagination: { page, per_page: 2, total_pages: 2 },
      trades: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
    }));
    const res = await collectPages(fetchPage, { page: 1, per_page: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(res.trades).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it('returns a non-list first page unchanged after a single request', async () => {
    const fetchPage = vi.fn(async () => ({ total_pnl: 25000, win_rate: 0.65 }));
    const res = await collectPages(fetchPage, { page: 1 });
    expect(res).toEqual({ total_pnl: 25000, win_rate: 0.65 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws a structured first-page failure instead of returning it as a result', async () => {
    const failure = {
      success: false,
      error: 'Invalid list filter',
      code: 'INVALID_PARAMS',
      status: 400,
      details: { field: 'filters' },
      data: [],
    };
    const fetchPage = vi.fn(async () => failure);

    await expect(collectPages(fetchPage, { page: 1, per_page: 10 })).rejects.toMatchObject({
      name: 'NansenError',
      message: 'Invalid list filter',
      code: 'INVALID_PARAMS',
      status: 400,
      details: { field: 'filters' },
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws a mid-traversal failure without returning the rows collected so far', async () => {
    const fetchPage = vi.fn(async ({ page }) => {
      if (page === 1) return { data: [{ id: 1 }, { id: 2 }] };
      return {
        success: false,
        error: { message: 'Page cursor expired', code: 'INVALID_PARAMS', details: { cursor: 'old' } },
        status: 409,
        data: { data: [] },
      };
    });

    await expect(collectPages(fetchPage, { page: 1, per_page: 2 })).rejects.toMatchObject({
      name: 'NansenError',
      message: 'Page cursor expired',
      code: 'INVALID_PARAMS',
      status: 409,
      details: { cursor: 'old' },
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('propagates a mid-traversal error unchanged', async () => {
    const fetchPage = vi.fn(async ({ page }) => {
      if (page === 2) throw Object.assign(new Error('boom'), { code: 'RATE_LIMITED' });
      return { data: [{ id: 1 }] };
    });
    await expect(collectPages(fetchPage, { page: 1, per_page: 1 })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('enableAutoPagination', () => {
  function fakeApi() {
    const api = {
      request: vi.fn(async (endpoint, body) => {
        if (!body.pagination) return { single: true };
        const { page } = body.pagination;
        return { data: page < 3 ? [{ page, i: 0 }, { page, i: 1 }] : [{ page, i: 0 }] };
      }),
    };
    api.list = function (pagination) { return this.request('/list', { chains: ['solana'], pagination }); };
    api.info = function () { return this.request('/info', { chain: 'solana' }); };
    return api;
  }

  it('traverses list bodies (even when pagination is undefined) and keeps the other body fields', async () => {
    const api = fakeApi();
    const raw = api.request; // the spy; enableAutoPagination replaces api.request with the wrapper
    enableAutoPagination(api, { maxPages: 5 });
    const res = await api.list(undefined);
    expect(res.data).toHaveLength(5);
    expect(res.pagination).toMatchObject({ page: 1, pages_fetched: 3, complete: true });
    expect(raw.mock.calls.every(([endpoint, body]) => endpoint === '/list' && body.chains[0] === 'solana')).toBe(true);
    expect(raw.mock.calls.map(([, body]) => body.pagination.page)).toEqual([1, 2, 3]);
  });

  it('passes bodies without a pagination key straight through', async () => {
    const api = fakeApi();
    const raw = api.request;
    enableAutoPagination(api);
    expect(await api.info()).toEqual({ single: true });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0][1]).toEqual({ chain: 'solana' });
  });

  it.each([
    ['top-level data', { success: false, error: 'bad', data: [] }],
    ['nested data', { success: false, error: 'bad', data: { data: [] } }],
    ['nested results', { success: false, error: 'bad', data: { results: [] } }],
  ])('rejects a failed %s envelope instead of returning it as data', async (_name, failure) => {
    const raw = vi.fn(async () => failure);
    const api = { request: raw, lastResponseMeta: null, servedFromCache: false };
    enableAutoPagination(api);

    await expect(api.request('/list', { pagination: { page: 1, per_page: 10 } }))
      .rejects.toMatchObject({ name: 'NansenError', message: 'bad', code: 'UNKNOWN' });
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on an object without request()', () => {
    const api = { list: vi.fn() };
    expect(enableAutoPagination(api)).toBe(api);
  });

  it('aggregates credit metadata across live pages without changing the payload', async () => {
    const api = {
      lastResponseMeta: null,
      servedFromCache: false,
      request: vi.fn(async (_endpoint, body) => {
        const page = body.pagination.page;
        api.lastResponseMeta = {
          requestId: `req-${page}`,
          credits: { used: 2, remaining: 10 - page * 2, cost: 3 },
          rateLimit: { limit: 100, remaining: 100 - page, resetSeconds: 60 },
          ...(page === 1 && { notices: { planNotice: 'Plan notice' } }),
        };
        return { data: page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }] };
      }),
    };
    enableAutoPagination(api);

    const result = await api.request('/list', { pagination: { page: 1, per_page: 2 } });

    expect(result).toEqual({
      data: [{ id: 1 }, { id: 2 }, { id: 3 }],
      pagination: { page: 1, pages_fetched: 2, next_page: null, complete: true },
    });
    expect(api.lastResponseMeta.requestId).toBe('req-2');
    expect(api.paginatedResponseMeta).toEqual({
      requestId: 'req-2',
      credits: { used: 4, remaining: 6, cost: 6 },
      rateLimit: { limit: 100, remaining: 98, resetSeconds: 60 },
      notices: { planNotice: 'Plan notice' },
      pagination: { pagesFetched: 2, livePages: 2, cachedPages: 0 },
    });
  });

  it('does not charge cached pages or replace the freshest live metadata with stale cache state', async () => {
    const api = {
      lastResponseMeta: null,
      servedFromCache: false,
      request: vi.fn(async (_endpoint, body) => {
        const page = body.pagination.page;
        if (page === 1) {
          api.servedFromCache = false;
          api.lastResponseMeta = { credits: { used: 2, remaining: 8, cost: 3 } };
          return { data: [{ id: 1 }, { id: 2 }] };
        }
        api.servedFromCache = true;
        return { data: [{ id: 3 }] };
      }),
    };
    enableAutoPagination(api);

    await api.request('/list', { pagination: { page: 1, per_page: 2 } });

    expect(api.paginatedResponseMeta).toEqual({
      credits: { used: 2, remaining: 8, cost: 3 },
      pagination: { pagesFetched: 2, livePages: 1, cachedPages: 1 },
    });
  });

  it('keeps partial live/cache credit metadata and rethrows the original mid-traversal error', async () => {
    const failure = Object.assign(new Error('page three failed'), { code: 'RATE_LIMITED' });
    const api = {
      lastResponseMeta: null,
      servedFromCache: false,
      request: vi.fn(async (_endpoint, body) => {
        const page = body.pagination.page;
        if (page === 1) {
          api.servedFromCache = false;
          api.lastResponseMeta = { credits: { used: 2, remaining: 8, cost: 2 } };
          return { data: [{ id: 1 }] };
        }
        if (page === 2) {
          api.servedFromCache = true;
          return { data: [{ id: 2 }] };
        }
        api.servedFromCache = false;
        api.lastResponseMeta = { credits: { used: 4, remaining: 3, cost: 4 } };
        throw failure;
      }),
    };
    enableAutoPagination(api);

    let caught;
    try {
      await api.request('/list', { pagination: { page: 1, per_page: 1 } });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(failure);
    expect(caught.code).toBe('RATE_LIMITED');
    expect(api.paginatedResponseMeta).toEqual({
      credits: { used: 6, remaining: 3, cost: 6 },
      pagination: { pagesFetched: 3, livePages: 2, cachedPages: 1 },
    });
  });

  it('reports an all-cache traversal as zero cost instead of reusing stale response metadata', async () => {
    const api = {
      lastResponseMeta: { credits: { used: 99, remaining: 1, cost: 99 } },
      servedFromCache: true,
      request: vi.fn(async (_endpoint, body) => ({
        data: body.pagination.page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
      })),
    };
    enableAutoPagination(api);

    await api.request('/list', { pagination: { page: 1, per_page: 2 } });

    expect(api.paginatedResponseMeta).toEqual({
      credits: { used: 0, remaining: null, cost: 0 },
      pagination: { pagesFetched: 2, livePages: 0, cachedPages: 2 },
    });
  });
});
