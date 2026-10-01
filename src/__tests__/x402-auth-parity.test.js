import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NansenAPI } from '../api.js';
import { AuthError } from '../auth-credentials.js';
import { sessionFixture } from './fixtures/auth-fixture.js';

// Exercise the real payment dispatch, challenge parsing and policy. Only wallet
// custody, cryptographic signing, subprocesses and HTTP are test doubles.
const mocks = vi.hoisted(() => ({
  localSign: vi.fn(), wcSign: vi.fn(), wcAddress: vi.fn(),
  wallets: vi.fn(), provider: vi.fn(), privySign: vi.fn(),
}));
vi.mock('../wallet.js', () => ({
  getWalletConfig: () => ({ defaultWallet: 'test' }),
  showWallet: () => ({ provider: mocks.provider() }),
  listWallets: mocks.wallets,
  exportWallet: () => ({ name: 'test', evm: { privateKey: 'synthetic-key', address: '0x1111111111111111111111111111111111111111' } }),
}));
vi.mock('../x402-evm.js', async original => ({ ...await original(), createEvmPaymentPayload: mocks.localSign }));
vi.mock('../x402.js', async original => ({ ...await original(), checkX402Balance: async () => null }));
vi.mock('../walletconnect-exec.js', () => ({ wcExec: mocks.wcSign }));
vi.mock('../walletconnect-trading.js', () => ({ getWalletConnectAddress: mocks.wcAddress, parseWcJson: JSON.parse }));
vi.mock('../privy.js', () => ({ createPrivyPaymentSignatures: mocks.privySign }));

const origin = 'https://api.nansen.ai';
const endpoint = '/api/v1/token-screener';
const requirement = {
  scheme: 'exact', network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x2222222222222222222222222222222222222222', amount: '10000',
  maxTimeoutSeconds: 120, extra: { name: 'USD Coin', version: '2' },
};
const challenge = (overrides = {}) => ({ accepts: [{ ...requirement, ...overrides }] });
function paymentResponse(requirements = challenge(), { status = 402, bodyOnly = false, body = {} } = {}) {
  return new Response(JSON.stringify({ message: 'Payment required', ...body, ...(bodyOnly && { paymentRequirements: requirements }) }), {
    status, headers: bodyOnly ? {} : { 'payment-required': Buffer.from(JSON.stringify(requirements)).toString('base64') },
  });
}
function client(kind, options = {}) {
  const bundle = sessionFixture();
  const credential = kind === 'session'
    ? { kind, issuer: bundle.issuer, accountId: bundle.accountId, audience: origin, generation: 'synthetic-generation', expiresAt: bundle.expiresAt }
    : kind === 'api-key' ? { kind, apiKey: 'synthetic-api-key' } : { kind: 'anonymous' };
  const authState = { acquireSession: vi.fn().mockResolvedValue(bundle) };
  const api = new NansenAPI(null, origin, { credential, authState, retry: { maxRetries: 0 }, ...options });
  return { api, bundle, authState };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.provider.mockReturnValue('local');
  mocks.wallets.mockReturnValue({ defaultWallet: 'test', wallets: [{ name: 'test' }] });
  mocks.localSign.mockResolvedValue('synthetic-local-signature');
  mocks.wcAddress.mockResolvedValue('0x1111111111111111111111111111111111111111');
  mocks.wcSign.mockResolvedValue(JSON.stringify({ signature: 'synthetic-wc-signature' }));
  mocks.privySign.mockImplementation(async function* () { yield { signature: 'synthetic-privy-signature', network: 'eip155:8453' }; });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.stubEnv('NANSEN_X402_MAX_AMOUNT', '1');
  vi.stubEnv('NANSEN_X402_ALLOWED_PAYTO', '');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe.each(['api-key', 'session', 'anonymous'])('%s x402 payment policy', kind => {
  it.each(['local', 'walletconnect', 'privy'])('pays a 402 through %s without forwarding the account credential', async provider => {
    if (provider === 'walletconnect') mocks.wallets.mockReturnValue({ wallets: [] });
    if (provider === 'privy') mocks.provider.mockReturnValue('privy');
    const fetch = vi.fn().mockResolvedValueOnce(paymentResponse()).mockResolvedValueOnce(new Response('{"paid":true}'));
    vi.stubGlobal('fetch', fetch);
    const { api, bundle } = client(kind);
    await expect(api.request(endpoint, { chain: 'ethereum' })).resolves.toMatchObject({ paid: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = fetch.mock.calls[0][1];
    expect(first.headers.apikey).toBe(kind === 'api-key' ? 'synthetic-api-key' : undefined);
    expect(first.headers.Authorization).toBe(kind === 'session' ? `Bearer ${bundle.accessToken}` : undefined);
    const [url, paid] = fetch.mock.calls[1];
    expect(url).toBe(origin + endpoint);
    expect(paid.method).toBe(first.method);
    expect(paid.body).toBe(first.body);
    expect(paid.redirect).toBe('error');
    expect(paid.headers['Payment-Signature']).toBeTruthy();
    expect(Object.keys(paid.headers).map(name => name.toLowerCase())).not.toContain('authorization');
    expect(paid.headers.apikey).toBeUndefined();
    expect(api.selection.kind).toBe(kind);
  });

  it('supports a body-only WalletConnect challenge', async () => {
    mocks.wallets.mockReturnValue({ wallets: [] });
    const fetch = vi.fn().mockResolvedValueOnce(paymentResponse(challenge(), { bodyOnly: true })).mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await client(kind).api.request(endpoint);
    expect(mocks.wcSign).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 429, 451, 503])('never signs on HTTP %s even with a payment header and misleading body code', async status => {
    const fetch = vi.fn().mockResolvedValueOnce(paymentResponse(challenge(), { status, body: { code: 'payment_required' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(client(kind).api.request(endpoint)).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.localSign).not.toHaveBeenCalled();
    expect(mocks.wcSign).not.toHaveBeenCalled();
    expect(mocks.privySign).not.toHaveBeenCalled();
  });

  it('keeps login verification non-paying through allowPayment:false', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(paymentResponse()); vi.stubGlobal('fetch', fetch);
    await expect(client(kind, { allowPayment: false }).api.request(endpoint)).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.localSign).not.toHaveBeenCalled();
    expect(mocks.wcSign).not.toHaveBeenCalled();
    expect(mocks.privySign).not.toHaveBeenCalled();
  });

  it('never pays for the free account check, even with automatic payment enabled', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(paymentResponse()); vi.stubGlobal('fetch', fetch);
    await expect(client(kind).api.getAccount()).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.localSign).not.toHaveBeenCalled();
    expect(mocks.wcSign).not.toHaveBeenCalled();
    expect(mocks.privySign).not.toHaveBeenCalled();
  });

  it('cannot re-enable instance-disabled payment with a per-request override', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(paymentResponse());
    vi.stubGlobal('fetch', fetch);
    const { api } = client(kind, { allowPayment: false });
    await expect(api.request(endpoint, {}, { allowPayment: true })).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.localSign).not.toHaveBeenCalled();
    expect(mocks.wcSign).not.toHaveBeenCalled();
    expect(mocks.privySign).not.toHaveBeenCalled();
  });

  it.each([{ amount: '1000001' }, { asset: 'unknown-asset' }, { scheme: 'unsupported' }])('keeps wallet policy checks before signing: %j', async overrides => {
    const fetch = vi.fn().mockResolvedValueOnce(paymentResponse(challenge(overrides))); vi.stubGlobal('fetch', fetch);
    await expect(client(kind).api.request(endpoint)).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.localSign).not.toHaveBeenCalled();
    expect(mocks.wcSign).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 451, 503])('does not sign another option or use WalletConnect after a paid HTTP %s', async status => {
    // More than one supported option ensures the local loop itself must stop,
    // as well as the fallback to a second wallet provider.
    const requirements = { accepts: [requirement, { ...requirement, amount: '20000' }] };
    const fetch = vi.fn().mockResolvedValueOnce(paymentResponse(requirements)).mockImplementation(async () => new Response('{}', { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(client(kind).api.request(endpoint)).rejects.toMatchObject({ code: 'PAYMENT_AMBIGUOUS' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.localSign).toHaveBeenCalledOnce();
    expect(mocks.wcSign).not.toHaveBeenCalled();
  });
});

it('does not pay or dispatch after session acquisition fails', async () => {
  const { api, authState } = client('session');
  authState.acquireSession.mockRejectedValue(new AuthError('SESSION_RENEWAL_UNCERTAIN', 'Sign in again.'));
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(api.request(endpoint)).rejects.toMatchObject({ code: 'SESSION_RENEWAL_UNCERTAIN' });
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.localSign).not.toHaveBeenCalled();
  expect(mocks.wcSign).not.toHaveBeenCalled();
});

it('keeps malformed browser payment challenges and wallet errors out of diagnostics', async () => {
  const { api, bundle } = client('session');
  mocks.wallets.mockReturnValue({ wallets: [] });
  mocks.wcSign.mockRejectedValue(new Error(bundle.accessToken));
  const response = paymentResponse(challenge(), { bodyOnly: true, body: { message: bundle.accessToken } });
  response.headers.set('payment-required', bundle.accessToken);
  const fetch = vi.fn().mockResolvedValueOnce(response); vi.stubGlobal('fetch', fetch);
  const error = await api.request(endpoint).catch(error => error);
  expect(error.code).toBe('PAYMENT_REQUIRED');
  expect(error.message).toContain('wallet payment failed');
  expect(error.message).not.toContain('No API key');
  expect(JSON.stringify(error)).not.toContain(bundle.accessToken);
  expect(fetch).toHaveBeenCalledOnce();
});
