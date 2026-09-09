/**
 * Tests for revert-reason decoding (issue #81, narrow scope).
 *
 * PR #84 attempted a broader version of this fix (deny-list pre-checks +
 * revert decoding) and was closed by its own author: "approach needs more
 * thought on the right way to handle deny list checks and revert decoding."
 * This covers only the revert-decoding half — turning a bare
 * "Transaction reverted on-chain (status: 0x0)" into a message that explains
 * why, by replaying the transaction via eth_call at the block it was mined
 * in and decoding the standard Error(string)/Panic(uint256) ABI encodings.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { decodeRevertReason, getRevertReason, waitForReceipt } from '../trading.js';

function abiEncodeErrorString(message) {
  const bytes = Buffer.from(message, 'utf8');
  const lengthHex = bytes.length.toString(16).padStart(64, '0');
  const paddedLen = Math.ceil(bytes.length / 32) * 32;
  const dataHex = bytes.toString('hex').padEnd(paddedLen * 2, '0');
  const offsetHex = (32).toString(16).padStart(64, '0');
  return '0x08c379a2' + offsetHex + lengthHex + dataHex;
}

function abiEncodePanic(code) {
  return '0x4e487b71' + code.toString(16).padStart(64, '0');
}

describe('decodeRevertReason', () => {
  it('decodes a standard Error(string) revert', () => {
    const hex = abiEncodeErrorString('Insufficient liquidity');
    expect(decodeRevertReason(hex)).toBe('Insufficient liquidity');
  });

  it('decodes a Panic(uint256) revert into a known reason', () => {
    expect(decodeRevertReason(abiEncodePanic(0x11))).toBe('panic: arithmetic overflow or underflow (0x11)');
    expect(decodeRevertReason(abiEncodePanic(0x12))).toBe('panic: division or modulo by zero (0x12)');
    expect(decodeRevertReason(abiEncodePanic(0x32))).toBe('panic: array index out of bounds (0x32)');
  });

  it('labels an unrecognized panic code without guessing its meaning', () => {
    expect(decodeRevertReason(abiEncodePanic(0x99))).toBe('panic: unrecognized panic code (0x99)');
  });

  it('surfaces raw hex for a custom-error selector it does not recognize', () => {
    const hex = '0xdeadbeef' + '00'.repeat(32);
    const result = decodeRevertReason(hex);
    expect(result).toContain('unrecognized revert data');
    expect(result).toContain('0xdeadbeef');
  });

  it('returns null for empty/malformed input rather than throwing', () => {
    expect(decodeRevertReason(null)).toBeNull();
    expect(decodeRevertReason('')).toBeNull();
    expect(decodeRevertReason('not hex')).toBeNull();
    expect(decodeRevertReason('0x08c379a2')).toBeNull(); // Error(string) selector with no payload
  });

  it('does not throw on a length field that would read past the buffer', () => {
    // A hostile or corrupt payload claiming a huge string length must not crash the CLI.
    const hex = '0x08c379a2' + (32).toString(16).padStart(64, '0') + 'ff'.repeat(32);
    expect(decodeRevertReason(hex)).toBeNull();
  });
});

describe('getRevertReason', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockRpc(handlers) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = JSON.parse(opts.body);
      const handler = handlers[body.method];
      const result = handler ? handler(body) : { error: { message: 'unexpected method' } };
      return Promise.resolve({
        text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...result })),
      });
    }));
  }

  it('replays the tx at the mined block and decodes the Error(string) reason', async () => {
    mockRpc({
      eth_getTransactionByHash: () => ({
        result: { from: '0xFrom', to: '0xTo', input: '0xdata', value: '0x0', gas: '0x5208' },
      }),
      eth_call: () => ({ error: { message: 'execution reverted', data: abiEncodeErrorString('Insufficient liquidity') } }),
    });

    const reason = await getRevertReason('base', '0xhash', '0x100');
    expect(reason).toBe('Insufficient liquidity');
  });

  it('falls back to the RPC error message when no error.data is present', async () => {
    mockRpc({
      eth_getTransactionByHash: () => ({ result: { from: '0xFrom', to: '0xTo', input: '0xdata', value: '0x0' } }),
      eth_call: () => ({ error: { message: 'execution reverted: Deadline expired' } }),
    });

    const reason = await getRevertReason('base', '0xhash', '0x100');
    expect(reason).toBe('execution reverted: Deadline expired');
  });

  it('returns null when the replay unexpectedly succeeds (inconclusive, not a false "success")', async () => {
    mockRpc({
      eth_getTransactionByHash: () => ({ result: { from: '0xFrom', to: '0xTo', input: '0xdata', value: '0x0' } }),
      eth_call: () => ({ result: '0x' }),
    });

    expect(await getRevertReason('base', '0xhash', '0x100')).toBeNull();
  });

  it('returns null (not a throw) when the original transaction cannot be found', async () => {
    mockRpc({ eth_getTransactionByHash: () => ({ result: null }) });
    expect(await getRevertReason('base', '0xhash', '0x100')).toBeNull();
  });

  it('returns null on a transport/network error during replay rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    expect(await getRevertReason('base', '0xhash', '0x100')).toBeNull();
  });
});

describe('waitForReceipt revert message (issue #81)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes the decoded reason in the thrown error when the tx reverted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = JSON.parse(opts.body);
      let result;
      if (body.method === 'eth_getTransactionReceipt') {
        result = { status: '0x0', blockNumber: '0x100' };
      } else if (body.method === 'eth_getTransactionByHash') {
        result = { from: '0xFrom', to: '0xTo', input: '0xdata', value: '0x0' };
      } else if (body.method === 'eth_call') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          error: { message: 'execution reverted', data: abiEncodeErrorString('Insufficient liquidity') },
        })) });
      }
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })) });
    }));

    await expect(waitForReceipt('base', '0xhash', 5000, 5))
      .rejects.toThrow('Transaction reverted on-chain (status: 0x0). Reason: Insufficient liquidity. Tx: 0xhash');
  });

  it('still reports the revert (without a Reason clause) when the cause cannot be decoded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = JSON.parse(opts.body);
      let result = null;
      if (body.method === 'eth_getTransactionReceipt') result = { status: '0x0', blockNumber: '0x100' };
      if (body.method === 'eth_getTransactionByHash') result = null; // can't even find the tx to replay
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })) });
    }));

    let thrown;
    try {
      await waitForReceipt('base', '0xhash', 5000, 5);
    } catch (e) {
      thrown = e;
    }
    expect(thrown.message).toBe('Transaction reverted on-chain (status: 0x0). Tx: 0xhash');
    expect(thrown.message).not.toContain('Reason:');
  });

  it('a failure while looking up the revert reason never masks the original revert', async () => {
    // getRevertReason itself must never let a secondary error escape and
    // replace the real "Transaction reverted" error the caller is expecting.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({
          jsonrpc: '2.0', id: body.id, result: { status: '0x0', blockNumber: '0x100' },
        })) });
      }
      // Anything else (the reason lookup) blows up entirely.
      return Promise.reject(new TypeError('boom'));
    }));

    await expect(waitForReceipt('base', '0xhash', 5000, 5))
      .rejects.toThrow('Transaction reverted on-chain (status: 0x0). Tx: 0xhash');
  });
});
