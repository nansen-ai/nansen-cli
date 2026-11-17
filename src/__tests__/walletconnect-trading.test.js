/**
 * Tests for walletconnect-trading module
 *
 * Covers: getWalletConnectAddress, sendTransactionViaWalletConnect, sendApprovalViaWalletConnect
 * All subprocess calls are mocked via vi.mock('child_process').
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import {
  getWalletConnectAddress,
  sendTransactionViaWalletConnect as sendTransactionRaw,
  sendSolanaTransactionViaWalletConnect as sendSolanaRaw,
  sendApprovalViaWalletConnect as sendApprovalRaw,
  parseWcJson,
} from '../walletconnect-trading.js';
import { signEip1559Transaction } from '../trading.js';
import { base58Encode } from '../wallet.js';
import { TEST_EVM_ADDRESS, TEST_EVM_KEY, TEST_SOL_ADDRESS, TEST_SOL_PUBKEY_BYTES, signSolanaSlot } from './fixtures/remote-signers.js';

// The send functions check signed bytes against the connected wallet, so they
// take its address. Most tests here are about the subprocess call, not that
// check, so these wrappers supply the test wallet.
const sendTransactionViaWalletConnect = (txData, timeoutMs, opts = { from: TEST_EVM_ADDRESS }) => sendTransactionRaw(txData, timeoutMs, opts);
const sendSolanaTransactionViaWalletConnect = (txBase58, timeoutMs, opts = { signer: TEST_SOL_ADDRESS }) => sendSolanaRaw(txBase58, timeoutMs, opts);
const sendApprovalViaWalletConnect = (token, spender, chainId, amount, maxAllowance, opts = {}) =>
  sendApprovalRaw(token, spender, chainId, amount, maxAllowance, { from: TEST_EVM_ADDRESS, ...opts });

// An unsigned one-instruction Solana transaction (fee payer = test wallet), and
// the same transaction signed by the test wallet, both base58 as WalletConnect
// carries them.
function solanaTxBase64(blockhashByte = 3) {
  return Buffer.concat([
    Buffer.from([1]), Buffer.alloc(64),
    Buffer.from([1, 0, 1, 2]), TEST_SOL_PUBKEY_BYTES, Buffer.alloc(32, 2), Buffer.alloc(32, blockhashByte), Buffer.from([1, 1, 1, 0, 1, 0]),
  ]).toString('base64');
}
const TX_B58 = base58Encode(Buffer.from(solanaTxBase64(), 'base64'));
const SIGNED_B58 = base58Encode(Buffer.from(signSolanaSlot(solanaTxBase64()), 'base64'));

function mockExecFile(stdout, err = null) {
  execFile.mockImplementation((cmd, args, opts, cb) => {
    if (err) {
      cb(err, '', '');
    } else {
      cb(null, stdout, '');
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============= parseWcJson =============

describe('parseWcJson', () => {
  it('reads a single-line result after status lines', () => {
    expect(parseWcJson('Connecting...\nWaiting for approval\n{"txHash":"0xabc"}'))
      .toEqual({ txHash: '0xabc' });
  });

  it('reads a pretty-printed result', () => {
    const out = 'Waiting for approval...\n' + JSON.stringify({ txHash: '0xabc', chainId: 8453 }, null, 2);
    expect(parseWcJson(out)).toEqual({ txHash: '0xabc', chainId: 8453 });
  });

  // The scanner counted every literal brace, including ones inside string
  // values, so a wallet message containing "}" ended the object one line
  // early and a valid result failed to parse.
  it('ignores braces inside string values', () => {
    const payload = { txHash: '0xabc', walletMessage: 'note: nonce gap detected, retried } ok' };
    expect(parseWcJson('Waiting...\n' + JSON.stringify(payload, null, 2))).toEqual(payload);
    const inline = { txHash: '0xdef', note: '}{' };
    expect(parseWcJson(JSON.stringify(inline, null, 2))).toEqual(inline);
  });

  it('handles escaped quotes and backslashes inside strings', () => {
    const payload = { message: 'he said "}" loudly', path: 'C:\\tmp\\' };
    expect(parseWcJson(JSON.stringify(payload, null, 2))).toEqual(payload);
  });

  it('stops at the end of the first object and ignores trailing output', () => {
    const out = JSON.stringify({ txHash: '0xabc' }, null, 2) + '\nSession closed.';
    expect(parseWcJson(out)).toEqual({ txHash: '0xabc' });
  });

  it('keeps nested objects intact', () => {
    const payload = { result: { inner: { depth: 2 } }, note: '}' };
    expect(parseWcJson(JSON.stringify(payload, null, 2))).toEqual(payload);
  });

  it('throws when the output contains no JSON', () => {
    expect(() => parseWcJson('Request rejected by wallet')).toThrow('No JSON output from walletconnect');
  });
});

// ============= getWalletConnectAddress =============

describe('getWalletConnectAddress', () => {
  it('returns address when connected', async () => {
    mockExecFile(JSON.stringify({
      connected: true,
      accounts: [{ address: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4' }],
    }));

    const address = await getWalletConnectAddress();
    expect(address).toBe('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    expect(execFile).toHaveBeenCalledWith('walletconnect', ['whoami', '--json'], expect.any(Object), expect.any(Function));
  });

  it('returns null when not connected', async () => {
    mockExecFile(JSON.stringify({ connected: false }));

    const address = await getWalletConnectAddress();
    expect(address).toBeNull();
  });

  it('returns null when no accounts', async () => {
    mockExecFile(JSON.stringify({ connected: true, accounts: [] }));

    const address = await getWalletConnectAddress();
    expect(address).toBeNull();
  });

  it('returns null on ENOENT (binary not found)', async () => {
    const err = new Error('spawn walletconnect ENOENT');
    err.code = 'ENOENT';
    mockExecFile('', err);

    const address = await getWalletConnectAddress();
    expect(address).toBeNull();
  });

  it('returns null on timeout', async () => {
    mockExecFile('', new Error('Command timed out'));

    const address = await getWalletConnectAddress();
    expect(address).toBeNull();
  });

  it('returns Solana address when chainType is solana', async () => {
    mockExecFile(JSON.stringify({
      connected: true,
      accounts: [
        { chain: 'eip155:1', address: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4' },
        { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' },
      ],
    }));

    const address = await getWalletConnectAddress('solana');
    expect(address).toBe('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  });

  it('returns EVM address when chainType is evm', async () => {
    mockExecFile(JSON.stringify({
      connected: true,
      accounts: [
        { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' },
        { chain: 'eip155:1', address: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4' },
      ],
    }));

    const address = await getWalletConnectAddress('evm');
    expect(address).toBe('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
  });

  it('returns null when chainType is solana but no Solana account', async () => {
    mockExecFile(JSON.stringify({
      connected: true,
      accounts: [
        { chain: 'eip155:1', address: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4' },
      ],
    }));

    const address = await getWalletConnectAddress('solana');
    expect(address).toBeNull();
  });

  it('rejects Solana devnet/testnet accounts (mainnet only)', async () => {
    mockExecFile(JSON.stringify({
      connected: true,
      accounts: [
        { chain: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', address: 'DevnetAddr123' },
        { chain: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', address: 'TestnetAddr456' },
      ],
    }));

    const address = await getWalletConnectAddress('solana');
    expect(address).toBeNull();
  });

  it('returns first address when no chainType (backward compat)', async () => {
    mockExecFile(JSON.stringify({
      connected: true,
      accounts: [
        { chain: 'eip155:1', address: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4' },
        { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' },
      ],
    }));

    const address = await getWalletConnectAddress();
    expect(address).toBe('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
  });

  it('returns the matching account when chainId matches the session (regression)', async () => {
    mockExecFile(JSON.stringify({
      connected: true,
      accounts: [{ chain: 'eip155:8453', address: '0xBaseAddr0000000000000000000000000000000' }],
    }));

    const address = await getWalletConnectAddress('evm', 8453);
    expect(address).toBe('0xBaseAddr0000000000000000000000000000000');
  });

  it('rejects a session approved for a different EVM chain instead of returning any eip155:* account (regression)', async () => {
    // Before this check existed, chainType === 'evm' matched ANY eip155:*
    // account regardless of which specific chain it was approved for -- a
    // session connected only to Ethereum mainnet (1) would be handed back
    // as if it were valid for Base (8453) too, since EVM addresses are
    // identical across chains and the code never compared the chain ID.
    mockExecFile(JSON.stringify({
      connected: true,
      accounts: [{ chain: 'eip155:1', address: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4' }],
    }));

    const address = await getWalletConnectAddress('evm', 8453);
    expect(address).toBeNull();
  });

  it('still matches any eip155:* account when chainId is omitted (backward compat)', async () => {
    mockExecFile(JSON.stringify({
      connected: true,
      accounts: [{ chain: 'eip155:1', address: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4' }],
    }));

    const address = await getWalletConnectAddress('evm');
    expect(address).toBe('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
  });

  it('returns null for chainId lookup when no accounts are approved for any chain', async () => {
    mockExecFile(JSON.stringify({ connected: true, accounts: [] }));

    const address = await getWalletConnectAddress('evm', 8453);
    expect(address).toBeNull();
  });
});

// ============= sendTransactionViaWalletConnect =============

describe('sendTransactionViaWalletConnect', () => {
  it('sends correct JSON payload and returns txHash', async () => {
    mockExecFile(JSON.stringify({ txHash: '0xabc123' }));

    const result = await sendTransactionViaWalletConnect({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xdeadbeef',
      value: '1000000000000000000', // 1 ETH in wei
      gas: '21000',
      chainId: 8453,
    });

    expect(result).toEqual({ txHash: '0xabc123' });

    // Verify the command arguments
    expect(execFile).toHaveBeenCalledWith(
      'walletconnect',
      ['send-transaction', expect.any(String)],
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    );

    // Verify the JSON payload
    const payload = JSON.parse(execFile.mock.calls[0][1][1]);
    expect(payload.to).toBe('0x1234567890123456789012345678901234567890');
    expect(payload.data).toBe('0xdeadbeef');
    expect(payload.value).toBe('0xde0b6b3a7640000'); // 1 ETH in hex
    expect(payload.gas).toBe('0x5208'); // 21000 in hex
    expect(payload.chainId).toBe('eip155:8453');
  });

  it('handles transactionHash response from CLI', async () => {
    mockExecFile(JSON.stringify({ transactionHash: '0xtxhash123' }));

    const result = await sendTransactionViaWalletConnect({
      to: '0x1234567890123456789012345678901234567890',
      value: '0',
      chainId: 1,
    });

    expect(result).toEqual({ txHash: '0xtxhash123' });
  });

  it('passes through eip155: prefixed chainId', async () => {
    mockExecFile(JSON.stringify({ transactionHash: '0xabc' }));

    await sendTransactionViaWalletConnect({
      to: '0x1234567890123456789012345678901234567890',
      value: '0',
      chainId: 'eip155:10',
    });

    const payload = JSON.parse(execFile.mock.calls[0][1][1]);
    expect(payload.chainId).toBe('eip155:10');
  });

  // The wallet chooses nonce and fees (and gas when none is sent); the rest must be what was sent.
  const signedByWallet = (overrides = {}, key = TEST_EVM_KEY) => signEip1559Transaction({
    chainId: 1, nonce: '0x9', maxPriorityFeePerGas: '0x1', maxFeePerGas: '0x2', gasLimit: '0x5208',
    to: '0x1234567890123456789012345678901234567890', value: '0x0', data: '0x', ...overrides,
  }, key);
  const sentTx = { to: '0x1234567890123456789012345678901234567890', value: '0', chainId: 1 };

  it('handles signedTransaction response', async () => {
    const signed = signedByWallet();
    mockExecFile(JSON.stringify({ signedTransaction: signed }));

    const result = await sendTransactionViaWalletConnect(sentTx);

    expect(result).toEqual({ signedTransaction: signed });
  });

  it.each([
    ['a different recipient', { to: '0x000000000000000000000000000000000000dead' }, /to is 0x0+dead/],
    ['a different value', { value: '0x1' }, /value is 1, expected 0/],
    ['calldata added', { data: '0xa9059cbb' }, /data differs/],
    ['a different chain', { chainId: 8453 }, /chainId is 8453, expected 1/],
  ])('refuses a signedTransaction with %s, keeping its own error code', async (_name, change, message) => {
    mockExecFile(JSON.stringify({ signedTransaction: signedByWallet(change) }));

    const err = await sendTransactionViaWalletConnect(sentTx, undefined, { from: TEST_EVM_ADDRESS, label: 'swap transaction' }).catch(e => e);

    expect(err).toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(message) });
    expect(err.message).toMatch(/the wallet may have; check the wallet's activity before retrying/);
  });

  it('refuses a signedTransaction whose gas limit differs from the gas sent', async () => {
    mockExecFile(JSON.stringify({ signedTransaction: signedByWallet({ gasLimit: '0x7530' }) }));

    await expect(sendTransactionViaWalletConnect({ ...sentTx, gas: 210000 }))
      .rejects.toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/gasLimit is 30000, expected 210000/) });
  });

  it('accepts any gas limit when no gas was sent', async () => {
    const signed = signedByWallet({ gasLimit: '0x7530' });
    mockExecFile(JSON.stringify({ signedTransaction: signed }));

    await expect(sendTransactionViaWalletConnect(sentTx)).resolves.toEqual({ signedTransaction: signed });
  });

  it('refuses a signedTransaction from another key', async () => {
    mockExecFile(JSON.stringify({ signedTransaction: signedByWallet({}, '22'.repeat(32)) }));

    await expect(sendTransactionViaWalletConnect(sentTx)).rejects.toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/signed by 0x/) });
  });

  it('requires the wallet address it checks signed bytes against', async () => {
    await expect(sendTransactionRaw(sentTx)).rejects.toThrow(/wallet address \(from\) is required/);
    await expect(sendSolanaRaw(TX_B58)).rejects.toThrow(/wallet address \(signer\) is required/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('handles status messages before JSON output', async () => {
    mockExecFile('Connecting to wallet...\nWaiting for approval...\n' + JSON.stringify({ txHash: '0xdef456' }));

    const result = await sendTransactionViaWalletConnect({
      to: '0x1234567890123456789012345678901234567890',
      value: '0',
      chainId: 1,
    });

    expect(result).toEqual({ txHash: '0xdef456' });
  });

  it('converts value to hex correctly for zero', async () => {
    mockExecFile(JSON.stringify({ txHash: '0xabc' }));

    await sendTransactionViaWalletConnect({
      to: '0x1234567890123456789012345678901234567890',
      value: '0',
      chainId: 1,
    });

    const payload = JSON.parse(execFile.mock.calls[0][1][1]);
    expect(payload.value).toBe('0x0');
  });

  it('omits gas when not provided', async () => {
    mockExecFile(JSON.stringify({ txHash: '0xabc' }));

    await sendTransactionViaWalletConnect({
      to: '0x1234567890123456789012345678901234567890',
      value: '0',
      chainId: 1,
    });

    const payload = JSON.parse(execFile.mock.calls[0][1][1]);
    expect(payload.gas).toBeUndefined();
  });

  it('throws on timeout', async () => {
    mockExecFile('', new Error('Command timed out'));

    await expect(sendTransactionViaWalletConnect({
      to: '0x1234567890123456789012345678901234567890',
      value: '0',
      chainId: 1,
    })).rejects.toThrow('Command timed out');
  });

  it('throws when no JSON output', async () => {
    mockExecFile('Some non-JSON output');

    await expect(sendTransactionViaWalletConnect({
      to: '0x1234567890123456789012345678901234567890',
      value: '0',
      chainId: 1,
    })).rejects.toThrow('No JSON output');
  });

  it('uses custom timeout', async () => {
    mockExecFile(JSON.stringify({ txHash: '0xabc' }));

    await sendTransactionViaWalletConnect({
      to: '0x1234567890123456789012345678901234567890',
      value: '0',
      chainId: 1,
    }, 60000);

    expect(execFile).toHaveBeenCalledWith(
      'walletconnect',
      expect.any(Array),
      expect.objectContaining({ timeout: 60000 }),
      expect.any(Function),
    );
  });
});

// ============= sendApprovalViaWalletConnect =============

describe('sendApprovalViaWalletConnect', () => {
  it('builds correct approve calldata', async () => {
    mockExecFile(JSON.stringify({ txHash: '0xapproval123' }));

    const result = await sendApprovalViaWalletConnect(
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      '0xDef1C0ded9bec7F1a1670819833240f027b25EfF', // 0x router
      8453, // Base
      1000000n, // scoped to the trade amount, not unlimited
    );

    expect(result).toEqual({ txHash: '0xapproval123' });

    const payload = JSON.parse(execFile.mock.calls[0][1][1]);
    expect(payload.to).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(payload.chainId).toBe('eip155:8453');
    expect(payload.value).toBe('0x0');

    // Verify approve(address, uint256) calldata
    const data = payload.data;
    expect(data).toMatch(/^0x095ea7b3/); // approve selector
    // spender address padded to 32 bytes
    expect(data.slice(10, 74)).toBe('def1c0ded9bec7f1a1670819833240f027b25eff'.padStart(64, '0'));
    // amount is scoped to the trade (1000000), not unlimited MAX_UINT256
    expect(data.slice(74)).toBe((1000000n).toString(16).padStart(64, '0'));
    expect(data.slice(74)).not.toBe('f'.repeat(64));
  });

  it('sends with gas limit of 100000', async () => {
    mockExecFile(JSON.stringify({ txHash: '0xabc' }));

    await sendApprovalViaWalletConnect(
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',
      1,
      1000000n,
    );

    const payload = JSON.parse(execFile.mock.calls[0][1][1]);
    expect(payload.gas).toBe('0x186a0'); // 100000 in hex
  });

  it('builds zero-amount revoke calldata when explicitly allowed', async () => {
    mockExecFile(JSON.stringify({ txHash: '0xrevoke123' }));

    await sendApprovalViaWalletConnect(
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',
      8453,
      0n,
      undefined,
      { allowZero: true },
    );

    const payload = JSON.parse(execFile.mock.calls[0][1][1]);
    expect(payload.data.slice(74)).toBe('0'.repeat(64));
  });
});

// ============= sendSolanaTransactionViaWalletConnect =============

describe('sendSolanaTransactionViaWalletConnect', () => {
  it('sends correct payload and returns signedTransaction', async () => {
    mockExecFile(JSON.stringify({ signedTransaction: SIGNED_B58 }));

    const result = await sendSolanaTransactionViaWalletConnect(TX_B58);

    expect(result).toEqual({ signedTransaction: SIGNED_B58 });

    // Verify the command arguments
    expect(execFile).toHaveBeenCalledWith(
      'walletconnect',
      ['send-transaction', expect.any(String)],
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    );

    // Verify the JSON payload
    const payload = JSON.parse(execFile.mock.calls[0][1][1]);
    expect(payload.transaction).toBe(TX_B58);
    expect(payload.chainId).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  });

  it('refuses a signed transaction whose message differs from the one sent', async () => {
    const other = base58Encode(Buffer.from(signSolanaSlot(solanaTxBase64(9)), 'base64'));
    mockExecFile(JSON.stringify({ signedTransaction: other }));

    await expect(sendSolanaTransactionViaWalletConnect(TX_B58, undefined, { signer: TEST_SOL_ADDRESS, label: 'swap transaction' }))
      .rejects.toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/swap transaction.*message bytes differ/) });
  });

  it('refuses the sent transaction returned without a valid wallet signature', async () => {
    mockExecFile(JSON.stringify({ transaction: TX_B58 }));

    await expect(sendSolanaTransactionViaWalletConnect(TX_B58)).rejects.toMatchObject({ code: 'SIGNED_TX_MISMATCH', message: expect.stringMatching(/no valid signature/) });
  });

  it('returns signature when wallet returns signature only', async () => {
    mockExecFile(JSON.stringify({ signature: '4vJ9...' }));

    const result = await sendSolanaTransactionViaWalletConnect(TX_B58);

    expect(result).toEqual({ signature: '4vJ9...' });
  });

  it('returns signedTransaction when wallet returns transaction field', async () => {
    mockExecFile(JSON.stringify({ transaction: SIGNED_B58 }));

    const result = await sendSolanaTransactionViaWalletConnect(TX_B58);

    expect(result).toEqual({ signedTransaction: SIGNED_B58 });
  });

  it('throws on timeout', async () => {
    mockExecFile('', new Error('Command timed out'));

    await expect(sendSolanaTransactionViaWalletConnect(TX_B58)).rejects.toThrow('Command timed out');
  });

  it('throws when no JSON output', async () => {
    mockExecFile('Some non-JSON output');

    await expect(sendSolanaTransactionViaWalletConnect(TX_B58)).rejects.toThrow('No JSON output');
  });

  it('parses multi-line JSON output from walletconnect', async () => {
    const multiLineJson = `Connecting to wallet...\n{\n  "signedTransaction": "${SIGNED_B58}"\n}`;
    mockExecFile(multiLineJson);

    const result = await sendSolanaTransactionViaWalletConnect(TX_B58);
    expect(result).toEqual({ signedTransaction: SIGNED_B58 });
  });

  it('throws when unexpected response', async () => {
    mockExecFile(JSON.stringify({ unexpected: true }));

    await expect(sendSolanaTransactionViaWalletConnect(TX_B58)).rejects.toThrow('Unexpected response');
  });

  it('uses custom timeout', async () => {
    mockExecFile(JSON.stringify({ signedTransaction: SIGNED_B58 }));

    await sendSolanaTransactionViaWalletConnect(TX_B58, 60000);

    expect(execFile).toHaveBeenCalledWith(
      'walletconnect',
      expect.any(Array),
      expect.objectContaining({ timeout: 60000 }),
      expect.any(Function),
    );
  });
});

// Once the wallet has been asked to send, nothing that goes wrong afterwards
// proves the transaction stayed put — execFile collapses a user rejection, a
// 120s approval timeout and a spawn failure into the same bare Error. The flag
// is what stops trading.js reading any of them as "nothing was sent" and
// signing the next candidate on top of a possibly-live transaction. It is set
// at this boundary so every call site inherits it, including ones added later.
describe('WalletConnect sends mark every failure as an ambiguous handoff', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const sends = [
    ['sendTransactionViaWalletConnect', () => sendTransactionViaWalletConnect({ to: '0xabc', data: '0x', value: '0', gas: '21000', chainId: 8453 })],
    ['sendSolanaTransactionViaWalletConnect', () => sendSolanaTransactionViaWalletConnect(TX_B58)],
    ['sendApprovalViaWalletConnect', () => sendApprovalViaWalletConnect('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', 8453, 1000n)],
  ];

  for (const [name, call] of sends) {
    it(`${name}: a failed send is marked ambiguous`, async () => {
      mockExecFile('', new Error('Command failed: walletconnect send-transaction'));
      await expect(call()).rejects.toMatchObject({ broadcastAmbiguous: true });
    });

    it(`${name}: an unparseable reply is marked ambiguous`, async () => {
      mockExecFile('not json at all');
      await expect(call()).rejects.toMatchObject({ broadcastAmbiguous: true });
    });

    it(`${name}: a reply with no usable field is marked ambiguous`, async () => {
      mockExecFile(JSON.stringify({ unrelated: true }));
      await expect(call()).rejects.toMatchObject({ broadcastAmbiguous: true });
    });
  }

  it('leaves a successful send unmarked', async () => {
    mockExecFile(JSON.stringify({ transactionHash: '0xdeadbeef' }));
    await expect(sendTransactionViaWalletConnect({ to: '0xabc', data: '0x', value: '0', gas: '21000', chainId: 8453 }))
      .resolves.toEqual({ txHash: '0xdeadbeef' });
  });
});
