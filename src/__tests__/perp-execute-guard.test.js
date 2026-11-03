/**
 * --dry-run / --yes gate on the perp commands that change Hyperliquid state
 * (order, close, cancel, leverage).
 *
 * The signing seams (local secp256k1 signing, Privy typed-data signing) and the
 * only Hyperliquid submission seam (submitExchange) are spies, and global fetch
 * throws, so a dry run or a declined prompt that reached any of them fails the
 * test instead of passing quietly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../wallet.js', async (importOriginal) => ({
  ...(await importOriginal()),
  showWallet: vi.fn(),
  getWalletConfig: vi.fn(() => ({})),
  exportWallet: vi.fn(),
}));

vi.mock('../keychain.js', () => ({
  retrievePassword: vi.fn(() => ({ password: null, source: null })),
}));

vi.mock('../hl-client.js', () => ({
  submitExchange: vi.fn(async () => ({ status: 'ok', response: { data: { statuses: [{ resting: { oid: 1 } }] } } })),
}));

vi.mock('../crypto.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, signSecp256k1: vi.fn(actual.signSecp256k1) };
});

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal()),
  trackPerpOrderCompleted: vi.fn(),
}));

const privyMocks = vi.hoisted(() => ({
  getWallet: vi.fn(),
  ethSignTypedDataV4: vi.fn(),
}));
vi.mock('../privy.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PrivyClient: vi.fn().mockImplementation(function () {
    this.getWallet = privyMocks.getWallet;
    this.ethSignTypedDataV4 = privyMocks.ethSignTypedDataV4;
  }),
}));

import { exportWallet, getWalletConfig, showWallet } from '../wallet.js';
import { submitExchange } from '../hl-client.js';
import { signSecp256k1 } from '../crypto.js';
import { buildPerpCommands } from '../perp.js';
import { buildCommands } from '../cli.js';

const WALLET = '0x' + '1'.repeat(40);
const BUILDER = '0x' + 'ab'.repeat(20);
const KEY = '11'.repeat(32);
const ETH = { name: 'ETH', asset_id: 1, sz_decimals: 4, max_leverage: 50 };

const ORDER = { coin: 'ETH', side: 'buy', size: '0.01', price: '2000', type: 'limit', wallet: 'x' };
const CLOSE = { coin: 'ETH', side: 'sell', size: '0.01', price: '2000', wallet: 'x' };
const CANCEL = { coin: 'ETH', oid: '4242', wallet: 'x' };
const LEVERAGE = { coin: 'ETH', leverage: '5', 'margin-type': 'isolated', wallet: 'x' };

function mockApi({
  approved = true,
  positions = [],
  orders = [],
  sanctioned = false,
} = {}) {
  return {
    request: vi.fn(async (endpoint) => {
      if (endpoint.startsWith('/api/v1/perp/meta')) return { assets: [ETH] };
      if (endpoint.startsWith('/api/v1/perp/builder-fee')) {
        return { approved, max_fee_rate: approved ? 80 : 0, required_fee: 80, builder_address: BUILDER };
      }
      if (endpoint.startsWith('/api/v1/perp/positions')) return { positions };
      if (endpoint.startsWith('/api/v1/perp/orders')) return { orders };
      if (endpoint.startsWith('/api/v1/sanctions/screen')) return { results: [{ address: WALLET, sanctioned }] };
      throw new Error(`unexpected endpoint ${endpoint}`);
    }),
  };
}

const called = (api, prefix) => api.request.mock.calls.some(([endpoint]) => endpoint.startsWith(prefix));

function expectNothingSigned() {
  expect(submitExchange).not.toHaveBeenCalled();
  expect(signSecp256k1).not.toHaveBeenCalled();
  expect(privyMocks.ethSignTypedDataV4).not.toHaveBeenCalled();
}

let originalFetch;
beforeEach(() => {
  submitExchange.mockClear();
  signSecp256k1.mockClear();
  exportWallet.mockReset().mockReturnValue({ evm: { privateKey: KEY } });
  showWallet.mockReturnValue({ name: 'x', evm: WALLET, provider: 'local' });
  getWalletConfig.mockReturnValue({});
  privyMocks.getWallet.mockReset().mockResolvedValue({ id: 'pw-1', address: WALLET });
  privyMocks.ethSignTypedDataV4.mockReset().mockResolvedValue({ signature: '0x' + '11'.repeat(65) });
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => {
    throw new Error('no network in this test');
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function capture(extra = {}) {
  const out = [];
  const err = [];
  const cmds = buildPerpCommands({
    log: m => out.push(m),
    warn: () => {},
    confirmationLog: m => err.push(m),
    ...extra,
  });
  return { cmds, out, err, text: () => out.join('\n'), errText: () => err.join('\n') };
}

describe('perp --dry-run', () => {
  it('order: prints the plan and signs, approves and submits nothing', async () => {
    const { cmds, text } = capture();
    const api = mockApi({ approved: false, positions: [{ coin: 'ETH', szi: '0.5', entryPx: '1900', leverage: { type: 'cross', value: 10 } }] });

    const result = await cmds.order([], api, { 'dry-run': true }, {
      ...ORDER, type: 'market', 'take-profit': '2200', 'stop-loss': '1800',
    });

    expect(result).toBeUndefined();
    expectNothingSigned();
    // A dry run needs no key, so no password is read.
    expect(exportWallet).not.toHaveBeenCalled();
    const out = text();
    expect(out).toContain('Perp order plan — ETH');
    expect(out).toMatch(/Side:\s+buy \(long\)/);
    expect(out).toMatch(/Size:\s+0\.01 ETH/);
    expect(out).toMatch(/Type:\s+market \(IOC\)/);
    expect(out).toMatch(/Price:\s+2000 reference, worst fill 2060 \(3% slippage\)/);
    expect(out).toMatch(/Take-profit:\s+2200/);
    expect(out).toMatch(/Stop-loss:\s+1800/);
    expect(out).toMatch(/Est\. notional:\s+~\$20\.00 at the reference price, ~\$20\.60 at the worst fill/);
    expect(out).toMatch(/Leverage:\s+10x cross/);
    expect(out).toMatch(/Open position:\s+long 0\.5 @ 1900, 10x cross/);
    expect(out).toMatch(/Builder fee:.*Not yet approved/);
    expect(out).toContain('DRY RUN — nothing was sent to Hyperliquid');
    expect(out).not.toContain('quote');
    // The pre-submit header belongs to a real run only.
    expect(out).not.toContain('Perp Order:');
    // Screened like a real run would be right before signing.
    expect(called(api, '/api/v1/sanctions/screen')).toBe(true);
  });

  it('order: says the leverage is the account setting when there is no position', async () => {
    const { cmds, text } = capture();
    await cmds.order([], mockApi(), { 'dry-run': true }, ORDER);
    expect(text()).toMatch(/Leverage:\s+your current ETH setting, unchanged by this order/);
    expect(text()).toMatch(/Price:\s+2000$/m);
    expectNothingSigned();
  });

  it('order: still runs the normal validation', async () => {
    const { cmds } = capture();
    await expect(cmds.order([], mockApi(), { 'dry-run': true }, { ...ORDER, side: 'lng' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expectNothingSigned();
  });

  it('order: a blocked wallet fails the preview the same way a real run would', async () => {
    const { cmds } = capture();
    await expect(cmds.order([], mockApi({ sanctioned: true }), { 'dry-run': true }, ORDER))
      .rejects.toMatchObject({ code: 'SANCTIONED' });
    expectNothingSigned();
  });

  it('order: needs no password for an encrypted wallet', async () => {
    getWalletConfig.mockReturnValue({ passwordHash: 'hash', defaultWallet: 'x' });
    const { cmds, text } = capture();
    await cmds.order([], mockApi(), { 'dry-run': true }, ORDER);
    expect(text()).toContain('Perp order plan — ETH');
    expect(exportWallet).not.toHaveBeenCalled();
    expectNothingSigned();
  });

  it('order: a Privy wallet whose id does not match its address fails the preview', async () => {
    showWallet.mockReturnValue({ name: 'x', evm: WALLET, provider: 'privy', privyWalletIds: { evm: 'pw-1' } });
    privyMocks.getWallet.mockResolvedValue({ id: 'pw-1', address: '0x' + '2'.repeat(40) });
    const { cmds } = capture();
    await expect(cmds.order([], mockApi(), { 'dry-run': true }, ORDER)).rejects.toThrow(/does not match/);
    expectNothingSigned();
  });

  it('order: a Privy wallet is never asked to sign', async () => {
    showWallet.mockReturnValue({ name: 'x', evm: WALLET, provider: 'privy', privyWalletIds: { evm: 'pw-1' } });
    const { cmds } = capture();
    await cmds.order([], mockApi({ approved: false }), { 'dry-run': true }, ORDER);
    expectNothingSigned();
  });

  it('close: prints the plan and submits nothing', async () => {
    const { cmds, text } = capture();
    const api = mockApi({ positions: [{ coin: 'ETH', szi: '0.02', entryPx: '1950' }] });
    await cmds.close([], api, { 'dry-run': true }, CLOSE);
    expectNothingSigned();
    const out = text();
    expect(out).toContain('Perp close plan — ETH');
    expect(out).toMatch(/Side:\s+sell \(closes a long, reduce-only\)/);
    expect(out).toMatch(/Price:\s+2000 reference, worst fill 1940 \(3% slippage\)/);
    expect(out).toMatch(/Est\. notional:\s+~\$20\.00 at the reference price, ~\$19\.40 at the worst fill/);
    expect(out).toMatch(/Open position:\s+long 0\.02 @ 1950/);
  });

  it('shows the open position size exactly as the exchange reports it', async () => {
    const { cmds, text } = capture();
    const api = mockApi({ positions: [{ coin: 'ETH', szi: '-12345678.123456789', entryPx: '1950' }] });
    await cmds.leverage([], api, { 'dry-run': true }, LEVERAGE);
    expect(text()).toMatch(/Open position:\s+short 12345678\.123456789 @ 1950/);
  });

  it('reads the position side from the size string, even when a float would round it to zero', async () => {
    const { cmds, text } = capture();
    const tiny = `0.${'0'.repeat(330)}1`;
    const api = mockApi({ positions: [{ coin: 'ETH', szi: `-${tiny}`, entryPx: '1950' }] });
    await cmds.leverage([], api, { 'dry-run': true }, LEVERAGE);
    expect(text()).toMatch(new RegExp(`Open position:\\s+short ${tiny.replace('.', '\\.')} @ 1950`));
  });

  it('treats a zero or malformed position size as no position', async () => {
    for (const szi of ['0.000', '-0', '12abc', '']) {
      const { cmds, text } = capture();
      await cmds.leverage([], mockApi({ positions: [{ coin: 'ETH', szi, entryPx: '1950' }] }), { 'dry-run': true }, LEVERAGE);
      expect(text()).toMatch(/Open position:\s+none/);
    }
  });

  it('close: the direction check rejects the wrong side of a short', async () => {
    const { cmds } = capture();
    const api = mockApi({ positions: [{ coin: 'ETH', szi: '-0.02' }] });
    await expect(cmds.close([], api, { 'dry-run': true }, CLOSE))
      .rejects.toThrow(/Cannot close a short ETH position with --side sell/);
    expectNothingSigned();
  });

  it('describes the builder-fee approval as what a real run would do', async () => {
    const { cmds, text } = capture();
    await cmds.order([], mockApi({ approved: false }), { 'dry-run': true }, ORDER);
    expect(text()).toMatch(/Not yet approved: submitting signs and sends a one-time approval/);
    expect(text()).not.toMatch(/is signed and submitted first/);
  });

  it('close: the direction check still rejects the wrong side', async () => {
    const { cmds } = capture();
    const api = mockApi({ positions: [{ coin: 'ETH', szi: '0.02' }] });
    await expect(cmds.close([], api, { 'dry-run': true }, { ...CLOSE, side: 'buy' }))
      .rejects.toThrow(/Cannot close a long ETH position with --side buy/);
    expectNothingSigned();
  });

  it('cancel: prints the matching open order and submits nothing', async () => {
    const { cmds, text } = capture();
    const api = mockApi({ orders: [{ coin: 'ETH', side: 'B', sz: '0.01', limitPx: '1990', oid: 4242 }] });
    await cmds.cancel([], api, { 'dry-run': true }, CANCEL);
    expectNothingSigned();
    expect(text()).toContain('Perp cancel plan — ETH');
    expect(text()).toMatch(/Order id:\s+4242/);
    expect(text()).toMatch(/Order:\s+buy 0\.01 @ 1990/);
  });

  it('cancel: flags an order id that is not open', async () => {
    const { cmds, text } = capture();
    await cmds.cancel([], mockApi(), { 'dry-run': true }, CANCEL);
    expect(text()).toMatch(/Order:\s+not among the open ETH orders/);
    expectNothingSigned();
  });

  it('leverage: prints the plan and submits nothing', async () => {
    const { cmds, text } = capture();
    await cmds.leverage([], mockApi(), { 'dry-run': true }, LEVERAGE);
    expectNothingSigned();
    expect(text()).toContain('Perp leverage plan — ETH');
    expect(text()).toMatch(/Leverage:\s+5x/);
    expect(text()).toMatch(/Margin type:\s+isolated/);
    expect(text()).toMatch(/Asset maximum:\s+50x/);
  });

  it('leverage: the asset maximum check still applies', async () => {
    const { cmds } = capture();
    await expect(cmds.leverage([], mockApi(), { 'dry-run': true }, { ...LEVERAGE, leverage: '51' }))
      .rejects.toThrow(/exceeds the 50x maximum/);
    expectNothingSigned();
  });
});

describe('perp confirmation prompt (stdin is a terminal)', () => {
  it.each([
    ['order', ORDER, 'Submit this order to Hyperliquid?'],
    ['close', CLOSE, 'Submit this close order to Hyperliquid?'],
    ['cancel', CANCEL, 'Submit this cancel to Hyperliquid?'],
    ['leverage', LEVERAGE, 'Submit this leverage change to Hyperliquid?'],
  ])('%s: declining exits with CONFIRMATION_DECLINED and signs nothing', async (name, options, question) => {
    const promptFn = vi.fn(async () => 'n');
    const { cmds, errText, text } = capture({ isTTY: true, promptFn });
    const api = mockApi({ approved: false });

    const err = await cmds[name]([], api, {}, options).catch(e => e);

    expect(err.code).toBe('CONFIRMATION_DECLINED');
    expect(promptFn).toHaveBeenCalledWith(`${question} [y/N] `);
    expectNothingSigned();
    // The plan is shown on the prompt's channel, not stdout.
    expect(errText()).toContain(`Perp ${name} plan — ETH`);
    expect(text()).not.toContain('plan — ETH');
    // A declined action never decrypts the wallet.
    expect(exportWallet).not.toHaveBeenCalled();
  });

  it('loads the wallet key only after the user confirms', async () => {
    const promptFn = vi.fn(async () => {
      expect(exportWallet).not.toHaveBeenCalled();
      return 'yes';
    });
    const { cmds } = capture({ isTTY: true, promptFn });
    await cmds.leverage([], mockApi(), {}, LEVERAGE);
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(exportWallet).toHaveBeenCalledTimes(1);
    expect(submitExchange).toHaveBeenCalledTimes(1);
  });

  it('accepting the prompt signs and submits, approval first', async () => {
    const promptFn = vi.fn(async () => 'y');
    const { cmds } = capture({ isTTY: true, promptFn });
    await cmds.order([], mockApi({ approved: false }), {}, ORDER);
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(submitExchange.mock.calls.map(([c]) => c.action.type)).toEqual(['approveBuilderFee', 'order']);
  });

  it.each([
    ['--yes', { yes: true }, {}],
    ['-y', { y: true }, {}],
    ['NANSEN_YES=1', {}, { NANSEN_YES: '1' }],
  ])('%s skips the prompt', async (_label, flags, env) => {
    const promptFn = vi.fn(async () => 'n');
    const { cmds } = capture({ isTTY: true, promptFn, env });
    const api = mockApi();
    await cmds.order([], api, flags, ORDER);
    expect(promptFn).not.toHaveBeenCalled();
    expect(submitExchange).toHaveBeenCalledTimes(1);
    // No plan is built when nobody will read it.
    expect(called(api, '/api/v1/perp/positions')).toBe(false);
  });

  it('a terminal with no prompt available refuses instead of submitting', async () => {
    const { cmds } = capture({ isTTY: true });
    await expect(cmds.leverage([], mockApi(), {}, LEVERAGE))
      .rejects.toMatchObject({ code: 'CONFIRMATION_UNAVAILABLE' });
    expectNothingSigned();
  });
});

describe('perp off a terminal (agents, CI, pipes)', () => {
  it.each([
    ['order', ORDER],
    ['close', CLOSE],
    ['cancel', CANCEL],
    ['leverage', LEVERAGE],
  ])('%s proceeds without a prompt, as before', async (name, options) => {
    const promptFn = vi.fn(async () => 'n');
    const { cmds, text } = capture({ isTTY: false, promptFn });
    const api = mockApi();
    await cmds[name]([], api, {}, options);
    expect(promptFn).not.toHaveBeenCalled();
    expect(submitExchange).toHaveBeenCalledTimes(1);
    expect(text()).not.toContain('plan — ETH');
    // The unprompted path makes no extra reads for a plan.
    if (name !== 'close') expect(called(api, '/api/v1/perp/positions')).toBe(false);
    expect(called(api, '/api/v1/perp/orders')).toBe(false);
  });

  it('still reports a missing password before a metadata outage', async () => {
    getWalletConfig.mockReturnValue({ passwordHash: 'hash', defaultWallet: 'x' });
    const { cmds } = capture({ isTTY: false });
    const api = { request: vi.fn(async () => { throw new Error('proxy down'); }) };
    await expect(cmds.order([], api, {}, ORDER)).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    expectNothingSigned();
  });
});

describe('perp guard wiring through the CLI command table', () => {
  it('nansen perp order asks the terminal user before submitting', async () => {
    const confirmationPromptFn = vi.fn(async () => 'no');
    const stderr = [];
    const cmds = buildCommands({
      log: () => {},
      isTTY: true,
      confirmationPromptFn,
      confirmationLog: m => stderr.push(m),
    });
    const err = await cmds.perp(['order'], mockApi(), {}, ORDER).catch(e => e);
    expect(err.code).toBe('CONFIRMATION_DECLINED');
    expect(confirmationPromptFn).toHaveBeenCalledTimes(1);
    expect(stderr.join('\n')).toContain('Perp order plan — ETH');
    expectNothingSigned();
  });

  it('nansen perp leverage --dry-run returns without submitting', async () => {
    const out = [];
    const cmds = buildCommands({ log: m => out.push(m) });
    await cmds.perp(['leverage'], mockApi(), { 'dry-run': true }, LEVERAGE);
    expect(out.join('\n')).toContain('Perp leverage plan — ETH');
    expectNothingSigned();
  });
});
