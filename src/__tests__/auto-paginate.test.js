import { describe, it, expect, vi } from 'vitest';
import { collectPages, enableAutoPagination, DEFAULT_MAX_PAGES } from '../auto-paginate.js';

// Server with `total` rows of `size` per page under `{ data: [...] }`.
function server(total, size, extra = {}) {
  return vi.fn(async ({ page }) => {
    const start = (page - 1) * size;
    return { ...extra, data: Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => ({ id: start + i })) };
  });
}

describe('collectPages', () => {
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
    expect(res.pagination).toMatchObject({ total_pages: 1, pages_fetched: 1, complete: true });
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
