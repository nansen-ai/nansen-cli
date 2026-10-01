import { afterEach, expect, it, vi } from 'vitest';

const postMessage = vi.hoisted(() => vi.fn());
vi.mock('node:worker_threads', () => ({
  parentPort: { postMessage },
  workerData: { operation: 'get', account: 'synthetic' },
}));
afterEach(() => { vi.resetModules(); vi.doUnmock('@napi-rs/keyring'); postMessage.mockReset(); });

it.each(['import-error', 'invalid-export'])('reports only binding failure for %s', async kind => {
  vi.doMock('@napi-rs/keyring', () => {
    if (kind === 'import-error') throw new Error('private loader details');
    return { Entry: {} };
  });
  await import('../auth-store-native.js');
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ error: 'BINDING_MISSING' });
});

it('distinguishes a loaded binding whose OS store is unavailable', async () => {
  vi.doMock('@napi-rs/keyring', () => ({ Entry: class { constructor() { throw new Error('private OS details'); } } }));
  await import('../auth-store-native.js');
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ error: 'STORE_UNAVAILABLE' });
});
