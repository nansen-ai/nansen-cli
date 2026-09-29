import { describe, it, expect, vi } from 'vitest';
import { buildCommands, parseArgs } from '../cli.js';

function invoke(argv) {
  const api = {
    webSearch: vi.fn(async () => ({ results: [] })),
    webFetch: vi.fn(async () => ({ analysis: 'ok' })),
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

  it('treats --question true as the literal string "true", not a boolean', async () => {
    const { api, promise } = invoke([
      'fetch',
      'https://nansen.ai',
      '--question', 'true',
    ]);

    await promise;
    expect(api.webFetch).toHaveBeenCalledWith({
      urls: ['https://nansen.ai'],
      question: 'true',
    });
  });

  it('rejects non-string --question values instead of throwing TypeError', async () => {
    const { api, promise } = invoke([
      'fetch',
      'https://nansen.ai',
      '--question', '{"ask":"what"}',
    ]);

    await expect(promise).rejects.toThrow('--question must be a string');
    expect(api.webFetch).not.toHaveBeenCalled();
  });

  it('rejects repeated --question values clearly', async () => {
    const { api, promise } = invoke([
      'fetch',
      'https://nansen.ai',
      '--question', 'one',
      '--question', 'two',
    ]);

    await expect(promise).rejects.toThrow('--question may only be specified once');
    expect(api.webFetch).not.toHaveBeenCalled();
  });

  it('reports a blank --question instead of a bogus invalid-URL error', async () => {
    const { api, promise } = invoke([
      'fetch',
      'https://nansen.ai',
      '--question', '',
    ]);

    await expect(promise).rejects.toThrow('--question is required and cannot be blank');
    expect(api.webFetch).not.toHaveBeenCalled();
  });

  it('rejects a blank --url instead of silently fetching only the positional URL', async () => {
    const { api, promise } = invoke([
      'fetch',
      'https://nansen.ai',
      '--url', '',
      '--question', 'Summarize',
    ]);

    await expect(promise).rejects.toThrow('Invalid URL: ""');
    expect(api.webFetch).not.toHaveBeenCalled();
  });

  it('keeps valid string options unchanged', async () => {
    const search = invoke(['search', '--query', 'ethereum']);
    await search.promise;
    expect(search.api.webSearch).toHaveBeenCalledWith({
      queries: ['ethereum'],
      numResults: undefined,
    });

    const fetch = invoke([
      'fetch',
      'https://nansen.ai',
      '--question', 'What is Nansen?',
    ]);
    await fetch.promise;
    expect(fetch.api.webFetch).toHaveBeenCalledWith({
      urls: ['https://nansen.ai'],
      question: 'What is Nansen?',
    });
  });
});
