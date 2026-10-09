import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPaymentSignatures } from '../x402.js';
import { hasSufficientEvmPaymentBalance, EVM_X402_RPCS } from '../x402-payment-balance.js';
import { createEvmPaymentPayload } from '../x402-evm.js';

const OWNER = '0x' + '11'.repeat(20);
const OTHER_OWNER = '0x' + '33'.repeat(20);
const U = '0xcE24439F2D9C6a2289F741120FE202248B666666';
const USD1 = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d';
const AMOUNT = 50_000_000_000_000_000n;

vi.mock('../wallet.js', () => ({
  getWalletConfig: () => ({}),
  listWallets: () => ({ defaultWallet: 'test', wallets: [{ name: 'test', evm: OWNER }] }),
  exportWallet: name => ({ name, evm: { address: name === 'other' ? OTHER_OWNER : OWNER, privateKey: 'test-key' } }),
}));
vi.mock('../x402-evm.js', async importOriginal => ({
  ...await importOriginal(),
  createEvmPaymentPayload: vi.fn(req => `signature:${req.asset}`),
}));

function requirement(asset = U, amount = AMOUNT) {
  return {
    scheme: 'exact', network: 'eip155:56', asset, amount: String(amount),
    payTo: '0x' + '22'.repeat(20), maxTimeoutSeconds: 300,
    extra: { name: 'Test token', version: '1', assetTransferMethod: 'eip3009' },
  };
}
function response(requirements) {
  return { headers: new Headers({ 'payment-required': Buffer.from(JSON.stringify({ accepts: requirements })).toString('base64') }) };
}
async function signatures(requirements, options) {
  const items = [];
  for await (const item of createPaymentSignatures(response(requirements), 'https://example.com/resource', options)) items.push(item);
  return items;
}
function rpcResult(balance) {
  return { ok: true, json: async () => ({ result: '0x' + balance.toString(16) }) };
}

let fetchMock;
let log;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(createEvmPaymentPayload).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  log.mockRestore();
});

describe('automatic EVM payment balance checks', () => {
  it('skips unfunded U and signs only the funded USD1 option', async () => {
    fetchMock.mockImplementation(async (_url, init) => rpcResult(JSON.parse(init.body).params[0].to === U ? 0n : AMOUNT));
    const items = await signatures([requirement(U), requirement(USD1)]);
    expect(items.map(item => item.asset)).toEqual([USD1]);
    expect(createEvmPaymentPayload).toHaveBeenCalledTimes(1);
    expect(createEvmPaymentPayload.mock.calls[0][0].asset).toBe(USD1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('insufficient token balance'));
  });

  it('signs nothing when every option is unfunded', async () => {
    fetchMock.mockResolvedValue(rpcResult(0n));
    expect(await signatures([requirement(U), requirement(USD1)])).toEqual([]);
    expect(createEvmPaymentPayload).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Fund this token on this network'));
  });

  it.each([AMOUNT - 1n, AMOUNT, AMOUNT + 1n])('compares an 18-decimal balance of %s without rounding', async balance => {
    fetchMock.mockResolvedValue(rpcResult(balance));
    expect(await signatures([requirement()])).toHaveLength(balance >= AMOUNT ? 1 : 0);
  });

  it('queries the selected wallet, offered asset and exact network', async () => {
    fetchMock.mockResolvedValue(rpcResult(AMOUNT));
    await signatures([requirement(USD1)], { walletName: 'other' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(EVM_X402_RPCS['eip155:56']);
    expect(JSON.parse(init.body)).toMatchObject({ method: 'eth_call', params: [{ to: USD1, data: '0x70a08231' + OTHER_OWNER.slice(2).padStart(64, '0') }, 'latest'] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the resolved legacy amount when amount is empty', async () => {
    fetchMock.mockResolvedValue(rpcResult(AMOUNT - 1n));
    expect(await signatures([{ ...requirement(), amount: '', maxAmountRequired: String(AMOUNT) }])).toEqual([]);
  });

  it('does not query balances for an option rejected by payment policy', async () => {
    expect(await signatures([requirement(U, 2n * 10n ** 18n)])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createEvmPaymentPayload).not.toHaveBeenCalled();
  });

  it.each([
    { error: { code: -32000 } }, { result: null }, { result: '0x' },
    { result: 'not-hex' }, { result: '0x1', error: { code: -32000 } },
  ])('does not treat an unavailable balance as zero: %j', async data => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => data });
    expect(await signatures([requirement()])).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('deferring to server verification'));
  });

  it.each(['network failure', 'timeout'])('retains server verification after %s', async message => {
    fetchMock.mockRejectedValue(new Error(message));
    expect(await signatures([requirement()])).toHaveLength(1);
  });

  it('does not trust an HTTP error body as a balance', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ result: '0x0' }) });
    expect(await hasSufficientEvmPaymentBalance(requirement(), OWNER)).toBe(true);
  });
});
