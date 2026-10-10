import { describe, expect, it } from 'vitest';
import { formatCsv, formatOutput, formatTable } from '../cli.js';

const positions = [
  { position: { token_symbol: 'HYPE', size: 0.31, entry_price_usd: 72.169, leverage_value: 2 }, position_type: 'oneWay' },
  { position: { token_symbol: 'BTC', size: 0, entry_price_usd: 72830, leverage_value: 2 }, position_type: 'oneWay' },
];

const wrap = {
  payload: payload => payload,
  data: payload => ({ data: payload }),
  envelope: payload => ({ success: true, data: { data: payload } }),
};

// Exercise real formatters with the nested API shape, not a pre-flattened mock.
describe('profiler perp-positions tabular output', () => {
  for (const [shape, envelope] of Object.entries(wrap)) {
    it(`renders one table row per position from ${shape}`, () => {
      const input = envelope({ asset_positions: positions });
      const before = structuredClone(input);
      const text = formatTable(input);
      expect(text.split('\n')).toHaveLength(4);
      expect(text.split('\n')[0]).toContain('token_symbol');
      expect(text).toContain('HYPE');
      expect(text).toContain('BTC');
      expect(text).toContain('oneWay');
      expect(text).not.toContain('asset_positions');
      expect(text).not.toContain('{');
      expect(input).toEqual(before);
    });

    it(`renders lossless CSV rows from ${shape}`, () => {
      expect(formatCsv(envelope({ asset_positions: positions }))).toBe(
        'token_symbol,size,entry_price_usd,leverage_value,position_type\n'
        + 'HYPE,0.31,72.169,2,oneWay\nBTC,0,72830,2,oneWay',
      );
    });

    it(`renders empty positions from ${shape}`, () => {
      const input = envelope({ asset_positions: [], margin_summary: { account_value: 100 } });
      expect(formatTable(input)).toBe('No data');
      expect(formatCsv(input)).toBe('');
    });
  }

  it.each(['table', 'csv'])('normalizes the CLI envelope for %s', (mode) => {
    const input = wrap.envelope({ asset_positions: positions });
    const text = formatOutput(input, { [mode]: true }).text;
    expect(text).toContain('token_symbol');
    expect(text).toContain('HYPE');
    expect(text).toContain('BTC');
    expect(text).not.toContain('asset_positions');
  });

  it.each([false, true])('preserves JSON output with pretty=%s', (pretty) => {
    const input = wrap.envelope({ asset_positions: positions, margin_summary: { account_value: 100 } });
    formatOutput(input, { table: true });
    formatOutput(input, { csv: true });
    expect(formatOutput(input, { pretty }).text).toBe(JSON.stringify(input, null, pretty ? 2 : undefined));
    expect(input.data.data.asset_positions).toEqual(positions);
  });

  it.each([null, {}, [null], [{ position: null }], [{ position: [] }], [{ position: 'BTC' }]])(
    'preserves malformed position data rather than dropping it: %j', (assetPositions) => {
      const input = { data: { asset_positions: assetPositions } };
      expect(formatTable(input)).toContain('data');
      expect(formatCsv(input)).toContain('asset_positions');
    },
  );

  it('does not add a position_type column when the wrapper omits it', () => {
    expect(formatCsv({ asset_positions: [{ position: { token_symbol: 'BTC' } }] })).toBe('token_symbol\nBTC');
  });
});
