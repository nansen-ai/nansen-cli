import { describe, it, expect, vi } from 'vitest';
import { buildCommands, parseArgs } from '../cli.js';

function invoke(argv) {
  const api = {
    webSearch: vi.fn(async () => ({ results: [] })),
  };
  const { _: args, flags, options } = parseArgs(argv);
  const promise = buildCommands({})['web'](args, api, flags, options);
  return { api, promise };
}

describe('web string option validation', () => {
  it('treats --query true as the literal string "true", not a boolean', async () => {
    const { api, promise } = invoke(['search', '--query', 'true']);

    await promise;
    expect(api.webSearch).toHaveBeenCalledWith({
      queries: ['true'],
      numResults: undefined,
    });
  });

  it('rejects JSON object --query values with an actionable error', async () => {
    const { api, promise } = invoke(['search', '--query', '{"q":"btc"}']);

    await expect(promise).rejects.toThrow('--query values must be strings');
    expect(api.webSearch).not.toHaveBeenCalled();
  });

  it('rejects a non-string value inside repeated --query options', async () => {
    const { api, promise } = invoke([
      'search',
      '--query', 'bitcoin',
      '--query', '{"q":"btc"}',
    ]);

    await expect(promise).rejects.toThrow('--query values must be strings');
    expect(api.webSearch).not.toHaveBeenCalled();
  });

  it('keeps positional primitive-looking queries as normal strings', async () => {
    const { api, promise } = invoke(['search', 'true']);

    await promise;
    expect(api.webSearch).toHaveBeenCalledWith({
      queries: ['true'],
      numResults: undefined,
    });
  });

  it('keeps valid string options unchanged', async () => {
    const search = invoke(['search', '--query', 'ethereum']);
    await search.promise;
    expect(search.api.webSearch).toHaveBeenCalledWith({
      queries: ['ethereum'],
      numResults: undefined,
    });
  });
});
