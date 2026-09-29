import { describe, it, expect, vi } from 'vitest';
import { buildCommands, parseArgs } from '../cli.js';

function invoke(argv) {
  const api = {
    pmMarketScreener: vi.fn(async () => ({ data: [] })),
    pmEventScreener: vi.fn(async () => ({ data: [] })),
    pmCategories: vi.fn(async () => ({ data: [] })),
  };
  const { _: args, flags, options } = parseArgs(argv);
  const promise = buildCommands({})['prediction-market'](args, api, flags, options);
  return { api, promise };
}

describe('prediction-market numeric filter validation', () => {
  it('passes valid finite decimal filters through as numbers', async () => {
    const { api, promise } = invoke([
      'market-screener',
      '--min-liquidity', '12.5',
      '--max-price', '0.75',
    ]);

    await promise;

    expect(api.pmMarketScreener).toHaveBeenCalledWith(expect.objectContaining({
      minLiquidity: 12.5,
      maxPrice: 0.75,
    }));
  });

  it.each(['abc', 'NaN', 'Infinity'])(
    'rejects non-finite --min-liquidity value %s before the API call',
    async (value) => {
      const { api, promise } = invoke(['market-screener', '--min-liquidity', value]);

      await expect(promise).rejects.toThrow(
        `--min-liquidity must be a finite number; received: ${value}`,
      );
      expect(api.pmMarketScreener).not.toHaveBeenCalled();
    },
  );

  it('rejects -Infinity before the API call when parsed as a valueless option', async () => {
    const { api, promise } = invoke(['market-screener', '--min-liquidity', '-Infinity']);

    await expect(promise).rejects.toThrow('--min-liquidity requires a finite number');
    expect(api.pmMarketScreener).not.toHaveBeenCalled();
  });

  it('rejects repeated and valueless numeric filters', async () => {
    const repeated = invoke([
      'market-screener',
      '--min-volume-24hr', '10',
      '--min-volume-24hr', '20',
    ]);
    await expect(repeated.promise).rejects.toThrow('--min-volume-24hr may only be specified once');
    expect(repeated.api.pmMarketScreener).not.toHaveBeenCalled();

    const bare = invoke(['market-screener', '--min-open-interest']);
    await expect(bare.promise).rejects.toThrow('--min-open-interest requires a finite number');
    expect(bare.api.pmMarketScreener).not.toHaveBeenCalled();
  });

  it('validates shared event-screener filters too', async () => {
    const { api, promise } = invoke(['event-screener', '--max-liquidity', 'Infinity']);

    await expect(promise).rejects.toThrow(
      '--max-liquidity must be a finite number; received: Infinity',
    );
    expect(api.pmEventScreener).not.toHaveBeenCalled();
  });

  it('validates market-only price filters', async () => {
    const { api, promise } = invoke(['market-screener', '--min-price', 'NaN']);

    await expect(promise).rejects.toThrow('--min-price must be a finite number; received: NaN');
    expect(api.pmMarketScreener).not.toHaveBeenCalled();
  });

  it('does not start rejecting screener-only flags on unrelated subcommands', async () => {
    const { api, promise } = invoke(['categories', '--min-liquidity', 'Infinity']);

    await expect(promise).resolves.toEqual({ data: [] });
    expect(api.pmCategories).toHaveBeenCalledOnce();
  });
});
