/**
 * Transfer Tests — unit + integration coverage
 */

import { test, expect, vi, beforeEach, describe } from 'vitest';
import crypto from 'crypto';
import {
  sendTokens,
  rlpEncode,
  parseAmount,
  signSecp256k1,
  signEd25519,
  encodeCompactU16,
  base58Decode,
  base58DecodePubkey,
  deriveATA,
  validateEvmAddress,
  validateSolanaAddress,
  bigIntToHex,
} from '../transfer.js';
import { keccak256, base58Encode } from '../wallet.js';
import * as wallet from '../wallet.js';

// ============= Unit Tests =============

describe('RLP Encoding', () => {
  test('encodes empty string as 0x80', () => {
    expect(rlpEncode('0x')).toEqual(Buffer.from([0x80]));
  });

  test('encodes single byte < 0x80 as itself', () => {
    expect(rlpEncode('0x7f')).toEqual(Buffer.from([0x7f]));
  });

  test('encodes single byte 0x80 with length prefix', () => {
    expect(rlpEncode('0x80')).toEqual(Buffer.from([0x81, 0x80]));
  });

  test('encodes short string with length prefix', () => {
    const result = rlpEncode('0xdeadbeef');
    expect(result[0]).toBe(0x80 + 4); // length prefix
    expect(result.subarray(1).toString('hex')).toBe('deadbeef');
  });

  test('encodes zero as empty byte string', () => {
    expect(rlpEncode('0x0')).toEqual(Buffer.from([0x80]));
    expect(rlpEncode('0x')).toEqual(Buffer.from([0x80]));
  });

  test('encodes list', () => {
    const result = rlpEncode(['0x01', '0x02']);
    expect(result[0]).toBe(0xc0 + 2); // list prefix + length
  });

  test('encodes empty list', () => {
    expect(rlpEncode([])).toEqual(Buffer.from([0xc0]));
  });

  test('encodes nested list', () => {
    const result = rlpEncode([['0x01'], '0x02']);
    expect(result[0]).toBeGreaterThanOrEqual(0xc0);
  });

  test('strips leading zeros from hex', () => {
    const result = rlpEncode('0x0001');
    expect(result).toEqual(Buffer.from([0x01])); // single byte 1
  });
});

describe('Amount Parsing', () => {
  test('parses whole numbers', () => {
    expect(parseAmount('1', 18)).toBe(1000000000000000000n);
    expect(parseAmount('1', 9)).toBe(1000000000n);
    expect(parseAmount('1', 6)).toBe(1000000n);
  });

  test('parses decimals', () => {
    expect(parseAmount('1.5', 18)).toBe(1500000000000000000n);
    expect(parseAmount('0.1', 9)).toBe(100000000n);
    expect(parseAmount('0.000001', 6)).toBe(1n);
  });

  test('parses small amounts correctly', () => {
    expect(parseAmount('0.0001', 18)).toBe(100000000000000n);
    expect(parseAmount('0.005', 9)).toBe(5000000n);
  });

  test('truncates excess decimals', () => {
    // 6 decimal token, input has 9 decimals — should truncate
    expect(parseAmount('1.123456789', 6)).toBe(1123456n);
  });

  test('pads short decimals', () => {
    expect(parseAmount('1.1', 18)).toBe(1100000000000000000n);
  });
});

describe('Address Validation', () => {
  test('validates correct EVM addresses', () => {
    expect(validateEvmAddress('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4').valid).toBe(true);
    expect(validateEvmAddress('0x0000000000000000000000000000000000000000').valid).toBe(true);
  });

  test('rejects bad EVM addresses', () => {
    expect(validateEvmAddress('not-an-address').valid).toBe(false);
    expect(validateEvmAddress('0x123').valid).toBe(false);
    expect(validateEvmAddress('').valid).toBe(false);
    expect(validateEvmAddress(null).valid).toBe(false);
  });

  test('validates correct Solana addresses', () => {
    expect(validateSolanaAddress('11111111111111111111111111111111').valid).toBe(true);
    expect(validateSolanaAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM').valid).toBe(true);
  });

  test('rejects bad Solana addresses', () => {
    expect(validateSolanaAddress('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4').valid).toBe(false);
    expect(validateSolanaAddress('').valid).toBe(false);
  });
});

describe('Base58', () => {
  test('decodes known Solana system program', () => {
    const decoded = base58Decode('11111111111111111111111111111111');
    expect(decoded.length).toBe(32);
    expect(decoded.every(b => b === 0)).toBe(true);
  });

  test('round-trips with base58Encode', () => {
    const original = crypto.randomBytes(32);
    const encoded = base58Encode(original);
    const decoded = base58DecodePubkey(encoded);
    expect(decoded.toString('hex')).toBe(original.toString('hex'));
  });

  test('base58DecodePubkey pads to 32 bytes', () => {
    // '1' in base58 = single zero byte, should pad to 32
    const result = base58DecodePubkey('1');
    expect(result.length).toBe(32);
  });
});

describe('Compact-u16 Encoding', () => {
  test('encodes single-byte values', () => {
    expect(encodeCompactU16(0)).toEqual(Buffer.from([0]));
    expect(encodeCompactU16(1)).toEqual(Buffer.from([1]));
    expect(encodeCompactU16(127)).toEqual(Buffer.from([127]));
  });

  test('encodes two-byte values', () => {
    const buf = encodeCompactU16(128);
    expect(buf.length).toBe(2);
    expect(buf[0] & 0x80).toBe(0x80);
  });

  test('encodes 256 correctly', () => {
    const buf = encodeCompactU16(256);
    expect(buf.length).toBe(2);
    expect(buf[0]).toBe(0x80);
    expect(buf[1]).toBe(2);
  });
});

describe('secp256k1 ECDSA Signing', () => {
  // Use a known private key
  const privKey = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex');

  test('produces 32-byte r and s', () => {
    const hash = crypto.randomBytes(32);
    const sig = signSecp256k1(hash, privKey);
    expect(sig.r.length).toBe(32);
    expect(sig.s.length).toBe(32);
  });

  test('recovery is 0 or 1', () => {
    const hash = crypto.randomBytes(32);
    const sig = signSecp256k1(hash, privKey);
    expect([0, 1]).toContain(sig.recovery);
  });

  test('produces different signatures for different hashes', () => {
    const sig1 = signSecp256k1(crypto.randomBytes(32), privKey);
    const sig2 = signSecp256k1(crypto.randomBytes(32), privKey);
    expect(sig1.r.toString('hex')).not.toBe(sig2.r.toString('hex'));
  });

  test('is deterministic (RFC 6979)', () => {
    const hash = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex');
    const sig1 = signSecp256k1(hash, privKey);
    const sig2 = signSecp256k1(hash, privKey);
    expect(sig1.r.toString('hex')).toBe(sig2.r.toString('hex'));
    expect(sig1.s.toString('hex')).toBe(sig2.s.toString('hex'));
  });

  test('low-S normalization (EIP-2)', () => {
    // Run multiple signatures and verify s is always in the lower half
    const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    const halfN = N >> 1n;
    for (let i = 0; i < 10; i++) {
      const hash = crypto.randomBytes(32);
      const sig = signSecp256k1(hash, privKey);
      const s = BigInt('0x' + sig.s.toString('hex'));
      expect(s <= halfN).toBe(true);
    }
  });
});

describe('Ed25519 Signing', () => {
  test('produces 64-byte signature', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const seed = privateKey.subarray(privateKey.length - 32);
    const message = Buffer.from('hello world');
    const sig = signEd25519(message, seed);
    expect(sig.length).toBe(64);
  });

  test('is deterministic', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const seed = privateKey.subarray(privateKey.length - 32);
    const message = Buffer.from('test message');
    const sig1 = signEd25519(message, seed);
    const sig2 = signEd25519(message, seed);
    expect(sig1.toString('hex')).toBe(sig2.toString('hex'));
  });

  test('different messages produce different signatures', () => {
    const { privateKey } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const seed = privateKey.subarray(privateKey.length - 32);
    const sig1 = signEd25519(Buffer.from('msg1'), seed);
    const sig2 = signEd25519(Buffer.from('msg2'), seed);
    expect(sig1.toString('hex')).not.toBe(sig2.toString('hex'));
  });
});

describe('ATA Derivation', () => {
  test('produces a 32-byte result', () => {
    const ata = deriveATA(
      '11111111111111111111111111111111',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    expect(ata.length).toBe(32);
  });

  test('is deterministic', () => {
    const ata1 = deriveATA('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ata2 = deriveATA('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(ata1.toString('hex')).toBe(ata2.toString('hex'));
  });

  test('different owners produce different ATAs', () => {
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const prog = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const ata1 = deriveATA('11111111111111111111111111111111', mint, prog);
    const ata2 = deriveATA('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', mint, prog);
    expect(ata1.toString('hex')).not.toBe(ata2.toString('hex'));
  });
});

describe('bigIntToHex', () => {
  test('encodes zero as empty', () => {
    expect(bigIntToHex(0n)).toBe('0x');
  });

  test('encodes small values', () => {
    expect(bigIntToHex(1n)).toBe('0x1');
    expect(bigIntToHex(255n)).toBe('0xff');
  });

  test('encodes large values', () => {
    expect(bigIntToHex(8453n)).toBe('0x2105');
  });
});

// ============= Integration Tests =============

global.fetch = vi.fn();

describe('sendTokens integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(wallet, 'getWalletConfig').mockReturnValue({
      defaultWallet: 'test',
      passwordHash: { salt: 'test', hash: 'test' },
    });
    vi.spyOn(wallet, 'verifyPassword').mockReturnValue(true);
    vi.spyOn(wallet, 'exportWallet').mockReturnValue({
      name: 'test',
      evm: { address: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', privateKey: '0123456789abcdef'.repeat(4) },
      solana: { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', privateKey: '0123456789abcdef'.repeat(8) },
    });
  });

  describe('EVM', () => {
    // Smart mock that responds based on the RPC method
    function mockEvmRpcSmart() {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const responses = {
          'eth_getTransactionCount': '0x5',
          'eth_feeHistory': { baseFeePerGas: ['0x3b9aca00','0x3b9aca00','0x3b9aca00','0x3b9aca00','0x3b9aca00'] },
          'eth_getBalance': '0x8AC7230489E80000', // 10 ETH
          'eth_estimateGas': '0x5208', // 21000
          'eth_sendRawTransaction': '0xabc123',
          'eth_call': '0x' + 'f'.repeat(64), // large balance for balanceOf, or decimals
        };
        return { json: () => Promise.resolve({ result: responses[body.method] || '0x0' }) };
      });
    }

    test('sends native ETH and returns tx hash', async () => {
      mockEvmRpcSmart();
      const result = await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'evm', password: 'test' });
      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe('0xabc123');
      expect(result.chain).toBe('evm');
      expect(result.token).toBeNull();
    });

    test('sends on Base chain', async () => {
      mockEvmRpcSmart();
      const result = await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'base', password: 'test' });
      expect(result.chain).toBe('base');
    });

    test('sends ERC-20 with correct decimals fetch', async () => {
      let callCount = 0;
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const responses = {
          'eth_getTransactionCount': '0x0',
          'eth_feeHistory': { baseFeePerGas: ['0x1','0x1','0x1','0x1','0x1'] },
          'eth_estimateGas': '0xfe00',
          'eth_sendRawTransaction': '0xtoken_tx',
        };
        if (body.method === 'eth_call') {
          callCount++;
          // First eth_call = decimals(), second = balanceOf()
          if (callCount === 1) return { json: () => Promise.resolve({ result: '0x0000000000000000000000000000000000000000000000000000000000000012' }) };
          return { json: () => Promise.resolve({ result: '0x' + 'f'.repeat(64) }) };
        }
        return { json: () => Promise.resolve({ result: responses[body.method] || '0x0' }) };
      });

      const result = await sendTokens({
        to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '100', chain: 'evm',
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', password: 'test',
      });
      expect(result.success).toBe(true);
      expect(result.token).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    });

    test('builds valid EIP-1559 type 2 transaction', async () => {
      mockEvmRpcSmart();
      await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'evm', password: 'test' });

      // Find the sendRawTransaction call
      const sendRawCall = fetch.mock.calls.find(c => JSON.parse(c[1].body).method === 'eth_sendRawTransaction');
      expect(sendRawCall).toBeDefined();
      expect(JSON.parse(sendRawCall[1].body).params[0]).toMatch(/^0x02/);
    });

    test('uses eth_estimateGas instead of hardcoded gas limit', async () => {
      mockEvmRpcSmart();
      await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.01', chain: 'evm', password: 'test' });

      const estimateCall = fetch.mock.calls.find(c => JSON.parse(c[1].body).method === 'eth_estimateGas');
      expect(estimateCall).toBeDefined();
    });

    test('rejects when ETH balance is insufficient', async () => {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_getBalance') return { json: () => Promise.resolve({ result: '0x0' }) };
        if (body.method === 'eth_getTransactionCount') return { json: () => Promise.resolve({ result: '0x0' }) };
        if (body.method === 'eth_feeHistory') return { json: () => Promise.resolve({ result: { baseFeePerGas: ['0x3b9aca00','0x3b9aca00','0x3b9aca00','0x3b9aca00','0x3b9aca00'] } }) };
        return { json: () => Promise.resolve({ result: '0x0' }) };
      });

      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1.0', chain: 'evm', password: 'test' }))
        .rejects.toThrow('Insufficient ETH balance');
    });

    test('rejects when ERC-20 balance is insufficient', async () => {
      let callCount = 0;
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'eth_call') {
          callCount++;
          if (callCount === 1) return { json: () => Promise.resolve({ result: '0x0000000000000000000000000000000000000000000000000000000000000006' }) }; // decimals
          return { json: () => Promise.resolve({ result: '0x0' }) }; // balanceOf = 0
        }
        if (body.method === 'eth_getTransactionCount') return { json: () => Promise.resolve({ result: '0x0' }) };
        if (body.method === 'eth_feeHistory') return { json: () => Promise.resolve({ result: { baseFeePerGas: ['0x1','0x1','0x1','0x1','0x1'] } }) };
        return { json: () => Promise.resolve({ result: '0x0' }) };
      });

      await expect(sendTokens({
        to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '100', chain: 'evm',
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', password: 'test',
      })).rejects.toThrow('Insufficient token balance');
    });
  });

  describe('Solana', () => {
    function mockSolRpcSmart() {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const responses = {
          'getLatestBlockhash': { value: { blockhash: 'GHtXQBpokWApVtJPBteD6jHQJPMBpfDY4PPnSr3DSEJQ' } },
          'getBalance': { value: 1000000000 }, // 1 SOL
          'sendTransaction': 'sol_sig_123',
        };
        return { json: () => Promise.resolve({ result: responses[body.method] || null }) };
      });
    }

    test('sends native SOL', async () => {
      mockSolRpcSmart();
      const result = await sendTokens({ to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', amount: '0.5', chain: 'solana', password: 'test' });
      expect(result.success).toBe(true);
      expect(result.transactionHash).toBe('sol_sig_123');
    });

    test('broadcasts base64-encoded transaction', async () => {
      mockSolRpcSmart();
      await sendTokens({ to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', amount: '0.5', chain: 'solana', password: 'test' });

      const sendCall = fetch.mock.calls.find(c => JSON.parse(c[1].body).method === 'sendTransaction');
      const body = JSON.parse(sendCall[1].body);
      expect(body.params[1].encoding).toBe('base64');
      expect(() => Buffer.from(body.params[0], 'base64')).not.toThrow();
    });

    test('rejects when SOL balance is insufficient', async () => {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'getLatestBlockhash') return { json: () => Promise.resolve({ result: { value: { blockhash: 'GHtXQBpokWApVtJPBteD6jHQJPMBpfDY4PPnSr3DSEJQ' } } }) };
        if (body.method === 'getBalance') return { json: () => Promise.resolve({ result: { value: 100 } }) };
        return { json: () => Promise.resolve({ result: null }) };
      });

      await expect(sendTokens({ to: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', amount: '1.0', chain: 'solana', password: 'test' }))
        .rejects.toThrow('Insufficient SOL balance');
    });
  });

  describe('Error handling', () => {
    test('rejects invalid EVM address', async () => {
      await expect(sendTokens({ to: 'bad', amount: '1', chain: 'evm', password: 'test' })).rejects.toThrow('Invalid recipient');
    });

    test('rejects invalid Solana address', async () => {
      await expect(sendTokens({ to: '0xBadAddress', amount: '1', chain: 'solana', password: 'test' })).rejects.toThrow('Invalid recipient');
    });

    test('rejects wrong password', async () => {
      vi.spyOn(wallet, 'verifyPassword').mockReturnValue(false);
      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1', chain: 'evm', password: 'wrong' })).rejects.toThrow('Incorrect password');
    });

    test('rejects when no default wallet', async () => {
      vi.spyOn(wallet, 'getWalletConfig').mockReturnValue({ defaultWallet: null, passwordHash: {} });
      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1', chain: 'evm', password: 'test' })).rejects.toThrow('No wallet');
    });

    test('propagates RPC errors', async () => {
      fetch.mockImplementation(async () => ({ json: () => Promise.resolve({ error: { message: 'insufficient funds' } }) }));
      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1', chain: 'evm', password: 'test' })).rejects.toThrow('insufficient funds');
    });

    test('propagates network errors', async () => {
      fetch.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '1', chain: 'evm', password: 'test' })).rejects.toThrow('ECONNREFUSED');
    });

    test('uses specified wallet name', async () => {
      fetch.mockImplementation(async (url, opts) => {
        const body = JSON.parse(opts.body);
        const r = {
          'eth_getTransactionCount': '0x0',
          'eth_feeHistory': { baseFeePerGas: ['0x1','0x1','0x1','0x1','0x1'] },
          'eth_getBalance': '0x8AC7230489E80000',
          'eth_estimateGas': '0x5208',
          'eth_sendRawTransaction': '0x1',
        };
        return { json: () => Promise.resolve({ result: r[body.method] || '0x0' }) };
      });

      await sendTokens({ to: '0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4', amount: '0.001', chain: 'evm', wallet: 'my-wallet', password: 'test' });
      expect(wallet.exportWallet).toHaveBeenCalledWith('my-wallet', 'test');
    });
  });
});
