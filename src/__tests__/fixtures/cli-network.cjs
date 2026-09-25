// The smoke test exercises real parsing and env-key selection without services.
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.hostname !== 'api.nansen.ai') throw new Error('Unexpected CLI test endpoint');
  if (target.pathname === '/api/v1/smart-money/netflow') {
    if (options.headers.apikey !== 'test-env-key') throw new Error('Environment key not selected');
    return new Response('{"message":"synthetic unauthorized"}', { status: 401 });
  }
  return new Response('{}', { status: 404 });
};
