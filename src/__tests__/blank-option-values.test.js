import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCommands, parseArgs } from '../cli.js';
import { buildTradingCommands } from '../trading.js';
import { buildLimitOrderCommands } from '../limit-order.js';
import { buildWalletCommands, createWallet, showWallet } from '../wallet.js';
import { buildResearchCommands } from '../commands/research.js';
import { sendTokens } from '../transfer.js';
import { createPrivyWalletPair } from '../privy.js';

vi.mock('../transfer.js', async importOriginal => ({
  ...await importOriginal(),
  sendTokens: vi.fn().mockResolvedValue({ from: 'sender' }),
}));

vi.mock('../privy.js', () => ({
  createPrivyWalletPair: vi.fn().mockResolvedValue({
    name: 'default', evm: { address: 'evm-address' }, solana: { address: 'solana-address' },
  }),
}));

const deps = { log: vi.fn(), exit: vi.fn() };

// `trade quote` / `trade execute` screen the wallet against the sanctions list
// through the API instance before requesting a quote or signing (the gate itself
// is covered in trading-sanctions-screening.test.js). Tests here exercise other
// behaviour, so they get an API instance whose screen always reports clean.
const screenApi = {
  request: async (endpoint, body) => {
    if (endpoint.startsWith('/api/v1/sanctions/screen')) {
      return { results: (body?.addresses || []).map(address => ({ address, sanctioned: false })) };
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  },
};
let tempDir;
beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-blank-options-'));
  vi.stubEnv('HOME', tempDir);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network call')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const quoteOptions = { chain: 'base', from: 'ETH', to: 'USDC', amount: '1000' };
const sendOptions = { chain: 'base', to: '0x1111111111111111111111111111111111111111', amount: '1' };
const researchCases = [
  ['search', 'SOL', 'chain'],
  ['smart-money', 'historical-holdings', 'days'],
  ['profiler', 'historical-balances', 'days'],
  ['token', 'dex-trades', 'days'],
  ['perp', 'screener', 'days'],
  ['profiler', 'batch', 'delay'],
  ['profiler', 'trace', 'delay'],
  ['profiler', 'trace', 'depth'],
  ['smart-money', 'netflow', 'chain'],
  ['smart-money', 'netflow', 'chains'],
  ['profiler', 'balance', 'chain'],
  ['token', 'screener', 'chain'],
  ['token', 'screener', 'chains'],
  ['token', 'screener', 'timeframe'],
  ['token', 'ohlcv', 'timeframe'],
  ['token', 'flow-intelligence', 'timeframe'],
  ['token', 'who-bought-sold', 'buy-or-sell'],
];

describe.each(['', ' \t '])('explicit blank option %j', blank => {
  it.each(['swap-mode', 'wallet', 'to-chain', 'aggregator', 'amount-unit'])('rejects quote --%s', async name => {
    const parsed = parseArgs(['--' + name, blank]);
    await expect(buildTradingCommands(deps).quote([], screenApi, parsed.flags, {
      ...quoteOptions, ...parsed.options,
    })).rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringContaining(`--${name} requires a value. Usage: --${name} `) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects limit-order create --expires with positional tokens', async () => {
    const parsed = parseArgs(['SOL', 'USDC', '1', '--expires', blank]);
    await expect(buildLimitOrderCommands(deps).create(parsed._, null, parsed.flags, {
      ...parsed.options, 'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
    })).rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringContaining('--expires requires a value. Usage: --expires 7d') });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['create', 'list', 'cancel', 'update'])('rejects limit-order %s --wallet before authentication', async handler => {
    const parsed = parseArgs(['--wallet', blank]);
    await expect(buildLimitOrderCommands(deps)[handler]([], null, parsed.flags, {
      from: 'SOL', to: 'USDC', amount: '1', order: 'order-1',
      'trigger-mint': 'SOL', 'trigger-condition': 'below', 'trigger-price': '80',
      ...parsed.options,
    })).rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringContaining('--wallet requires a value') });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects execute --wallet before loading or signing a quote', async () => {
    const parsed = parseArgs(['quote-1', '--wallet', blank]);
    await expect(buildTradingCommands(deps).execute(parsed._, screenApi, parsed.flags, parsed.options))
      .rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringContaining('--wallet requires a value') });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['limit', 'offset', 'dir', 'mint'])('rejects limit-order list --%s', async name => {
    const parsed = parseArgs(['--' + name, blank]);
    await expect(buildLimitOrderCommands(deps).list([], null, parsed.flags, parsed.options))
      .rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringContaining(`--${name} requires a value`) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['local', 'privy'])('rejects %s wallet create --name even with a positional name', async provider => {
    const parsed = parseArgs(['create', 'positional-name', '--name', blank]);
    await expect(buildWalletCommands(deps).wallet(parsed._, null, { 'unsafe-no-password': true }, {
      ...parsed.options, provider,
    })).rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringContaining('--name requires a value') });
    expect(createPrivyWalletPair).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempDir, '.nansen', 'wallets'))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['token', 'wallet'])('rejects wallet send --%s', async name => {
    await expect(buildWalletCommands(deps).wallet(['send'], null, {}, {
      ...sendOptions, [name]: blank,
    })).rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringContaining(`--${name} requires a value`) });
    expect(sendTokens).not.toHaveBeenCalled();
  });

  it.each(researchCases)('rejects research %s %s --%s', async (category, sub, name) => {
    const api = { smartMoneyHistoricalHoldings: vi.fn(), addressHistoricalBalances: vi.fn(), tokenDexTrades: vi.fn(), perpScreener: vi.fn(), addressLabels: vi.fn(), addressBalance: vi.fn(), addressCounterparties: vi.fn().mockResolvedValue({ data: [] }), generalSearch: vi.fn(), tokenScreener: vi.fn(), tokenOhlcv: vi.fn(), tokenFlowIntelligence: vi.fn(), tokenWhoBoughtSold: vi.fn(), smartMoneyNetflow: vi.fn(), profilerBalance: vi.fn() };
    await expect(buildCommands(deps).research([category, sub], api, {}, {
      address: '0x1111111111111111111111111111111111111111',
      addresses: '0x1111111111111111111111111111111111111111',
      token: 'So11111111111111111111111111111111111111112', [name]: blank,
    })).rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringContaining(`--${name} requires a value`) });
    for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
  });

  it('rejects research profiler trace blank --width via integer validation', async () => {
    const api = { addressCounterparties: vi.fn().mockResolvedValue({ data: [] }) };
    await expect(buildCommands(deps).research(['profiler', 'trace'], api, {}, {
      address: '0x1111111111111111111111111111111111111111',
      width: blank,
    })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: expect.stringContaining('--width requires a non-negative safe integer value'),
    });
    expect(api.addressCounterparties).not.toHaveBeenCalled();
  });

  it.each([
    ['address-premium-labels', 'chain'],
    ['smart-money-pnl-leaderboard', 'chains'],
    ['chain-rank', 'chain-type'],
    ['chain-rank', 'timeframe-days'],
    ['historical-token-ohlcv', 'timeframe'],
  ])('rejects direct research %s --%s', async (sub, name) => {
    const api = { chainRank: vi.fn(), addressPremiumLabels: vi.fn(), smartMoneyPnlLeaderboard: vi.fn() };
    await expect(buildResearchCommands(deps).research([sub], api, {}, {
      address: '0x1111111111111111111111111111111111111111', [name]: blank,
    })).rejects.toMatchObject({ code: 'MISSING_PARAM', message: expect.stringContaining(`--${name} requires a value`) });
    for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
  });
});

it.each([0, '0', undefined])('preserves quote slippage caps %j and omitted quote defaults', async value => {
  createWallet('default', null);
  const wallet = showWallet('default');
  fetch.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ success: false, quotes: [] }) });
  const options = value === undefined ? {} : typeof value === 'string'
    ? parseArgs(['--slippage', value, '--max-auto-slippage', value]).options
    : { slippage: value, 'max-auto-slippage': value };
  // Stop at the mocked response after capturing the complete outgoing request.
  await expect(buildTradingCommands(deps).quote([], screenApi, { 'auto-slippage': true }, {
    ...quoteOptions, ...options,
  })).rejects.toThrow('No quotes available');
  const body = Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams);
  expect(body).toMatchObject({ chainIndex: '8453', amount: '1000', userWalletAddress: wallet.evm });
  expect(body).not.toHaveProperty('toChainIndex');
  expect(body).not.toHaveProperty('swapMode');
  if (value === undefined) {
    expect(body).not.toHaveProperty('slippagePercent');
    expect(body).not.toHaveProperty('maxAutoSlippagePercent');
  } else {
    expect(body.slippagePercent).toBe(String(value));
    expect(body.maxAutoSlippagePercent).toBe(String(value));
  }
});

it('keeps native token and default wallet selection when send options are omitted', async () => {
  createWallet('default', null);
  await buildWalletCommands(deps).wallet(['send'], null, { 'dry-run': true }, sendOptions);
  expect(sendTokens).toHaveBeenCalledWith(expect.objectContaining({ token: null, wallet: null }));
});

it('keeps research defaults when chain and timeframe options are omitted', async () => {
  const api = { tokenScreener: vi.fn(), chainRank: vi.fn(), addressPremiumLabels: vi.fn() };
  await buildCommands(deps).research(['token', 'screener'], api, {}, {});
  expect(api.tokenScreener).toHaveBeenCalledWith(expect.objectContaining({ chains: ['solana'], timeframe: '24h' }));
  await buildResearchCommands(deps).research(['chain-rank'], api, {}, {});
  expect(api.chainRank).toHaveBeenCalledWith({ chainType: 'all', timeFrame: 7 });
  await buildResearchCommands(deps).research(['address-premium-labels'], api, {}, { address: '0xabc' });
  expect(api.addressPremiumLabels).toHaveBeenCalledWith(expect.objectContaining({ chain: 'all' }));
});

it.each(['local', 'privy'])('keeps the default name for %s wallet creation when omitted', async provider => {
  await buildWalletCommands(deps).wallet(['create'], null, { 'unsafe-no-password': true }, { provider });
  if (provider === 'privy') {
    expect(createPrivyWalletPair).toHaveBeenCalledWith('default');
  } else {
    expect(showWallet('default').name).toBe('default');
  }
});

it.each([[undefined, 'BUY'], ['SELL', 'SELL']])('preserves who-bought-sold side %j', async (side, expected) => {
  const api = { tokenWhoBoughtSold: vi.fn() };
  const options = side === undefined ? {} : { 'buy-or-sell': side };
  await buildCommands(deps).research(['token', 'who-bought-sold'], api, {}, {
    token: 'So11111111111111111111111111111111111111112', ...options,
  });
  expect(api.tokenWhoBoughtSold).toHaveBeenCalledWith(expect.objectContaining({ buyOrSell: expected }));
});

describe.each([
  ['smart-money', 'historical-holdings', 'smartMoneyHistoricalHoldings'],
  ['profiler', 'historical-balances', 'addressHistoricalBalances'],
  ['token', 'dex-trades', 'tokenDexTrades'],
  ['perp', 'screener', 'perpScreener'],
])('research %s %s days', (category, subcommand, method) => {
  it.each([[undefined, 30], ['7', 7]])('preserves omitted or valid --days %j', async (days, expected) => {
    const api = { [method]: vi.fn() };
    await buildCommands(deps).research([category, subcommand], api, {}, days === undefined ? {} : { days });
    expect(api[method]).toHaveBeenCalledWith(expect.objectContaining({ days: expected }));
  });
});
