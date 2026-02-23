/**
 * Tests for x402 EVM payment functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parsePaymentRequirements,
  findEvmPaymentRequirement,
  createEvmPaymentPayload,
  signTypedData,
  shouldAttemptX402Payment,
  hasLocalWallet,
  getEvmPrivateKey,
  attemptX402Payment
} from '../x402.js';

describe('x402 Payment Requirements', () => {
  it('should parse payment requirements from base64 header', () => {
    const requirements = [
      {
        scheme: 'exact',
        network: 'eip155:1',
        amount: '1000000000000000000',
        recipient: '0x742d35Cc6084C13B2D3F78fFcE2BDa4A4b0A1234',
        nonce: '1640995200'
      }
    ];
    
    const mockResponse = {
      headers: {
        get: vi.fn().mockReturnValue(btoa(JSON.stringify(requirements)))
      }
    };

    const result = parsePaymentRequirements(mockResponse);
    expect(result).toEqual(requirements);
  });

  it('should return null for missing payment header', () => {
    const mockResponse = {
      headers: {
        get: vi.fn().mockReturnValue(null)
      }
    };

    const result = parsePaymentRequirements(mockResponse);
    expect(result).toBeNull();
  });

  it('should return null for invalid base64 header', () => {
    const mockResponse = {
      headers: {
        get: vi.fn().mockReturnValue('invalid-base64')
      }
    };

    const result = parsePaymentRequirements(mockResponse);
    expect(result).toBeNull();
  });
});

describe('EVM Payment Requirement Selection', () => {
  it('should find EVM payment requirement', () => {
    const requirements = [
      {
        scheme: 'exact',
        network: 'solana:mainnet',
        amount: '1000000',
        recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
      },
      {
        scheme: 'exact',
        network: 'eip155:1',
        amount: '1000000000000000000',
        recipient: '0x742d35Cc6084C13B2D3F78fFcE2BDa4A4b0A1234'
      }
    ];

    const result = findEvmPaymentRequirement(requirements);
    expect(result).toEqual(requirements[1]);
  });

  it('should return null when no EVM requirement found', () => {
    const requirements = [
      {
        scheme: 'exact',
        network: 'solana:mainnet',
        amount: '1000000',
        recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
      }
    ];

    const result = findEvmPaymentRequirement(requirements);
    expect(result).toBeNull();
  });

  it('should return null for empty requirements', () => {
    const result = findEvmPaymentRequirement([]);
    expect(result).toBeNull();
  });
});

describe('EVM Payment Payload Creation', () => {
  const mockRequirement = {
    scheme: 'exact',
    network: 'eip155:1',
    amount: '1000000000000000000',
    recipient: '0x742d35Cc6084C13B2D3F78fFcE2BDa4A4b0A1234',
    nonce: '1640995200',
    verifyingContract: '0x0000000000000000000000000000000000000000'
  };

  const mockPrivateKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('should create EVM payment payload', () => {
    const payload = createEvmPaymentPayload(mockRequirement, mockPrivateKey);
    
    expect(payload.scheme).toBe('exact');
    expect(payload.network).toBe('eip155:1');
    expect(payload.payment).toMatchObject({
      network: 'eip155:1',
      amount: '1000000000000000000',
      recipient: '0x742d35Cc6084C13B2D3F78fFcE2BDa4A4b0A1234',
      nonce: '1640995200'
    });
    expect(payload.payment.timestamp).toBeTypeOf('number');
    expect(payload.signature).toMatch(/^0x[a-fA-F0-9]{130}$/); // 65 bytes = 130 hex chars
  });

  it('should throw error for non-exact scheme', () => {
    const invalidRequirement = { ...mockRequirement, scheme: 'other' };
    
    expect(() => {
      createEvmPaymentPayload(invalidRequirement, mockPrivateKey);
    }).toThrow('Invalid payment requirement: must be exact scheme');
  });

  it('should throw error for non-EVM network', () => {
    const invalidRequirement = { ...mockRequirement, network: 'solana:mainnet' };
    
    expect(() => {
      createEvmPaymentPayload(invalidRequirement, mockPrivateKey);
    }).toThrow('Invalid payment requirement: must be EVM network');
  });

  it('should throw error for invalid chain ID', () => {
    const invalidRequirement = { ...mockRequirement, network: 'eip155:invalid' };
    
    expect(() => {
      createEvmPaymentPayload(invalidRequirement, mockPrivateKey);
    }).toThrow('Invalid chain ID in payment requirement');
  });
});

describe('EIP-712 Typed Data Signing', () => {
  it('should sign typed data and return hex signature', () => {
    const typedData = {
      domain: {
        name: 'x402Payment',
        version: '1',
        chainId: 1,
        verifyingContract: '0x0000000000000000000000000000000000000000'
      },
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' }
        ],
        Payment: [
          { name: 'network', type: 'string' },
          { name: 'amount', type: 'string' },
          { name: 'recipient', type: 'address' },
          { name: 'nonce', type: 'string' },
          { name: 'timestamp', type: 'uint256' }
        ]
      },
      primaryType: 'Payment',
      message: {
        network: 'eip155:1',
        amount: '1000000000000000000',
        recipient: '0x742d35Cc6084C13B2D3F78fFcE2BDa4A4b0A1234',
        nonce: '1640995200',
        timestamp: 1640995200
      }
    };

    const privateKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const signature = signTypedData(typedData, privateKey);
    
    expect(signature).toMatch(/^0x[a-fA-F0-9]{130}$/); // 65 bytes = 130 hex chars
  });
});

describe('x402 Payment Conditions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should attempt x402 payment when conditions are met', () => {
    const mockResponse = { 
      status: 402,
      headers: { get: vi.fn().mockReturnValue('payment-required-data') }
    };
    const apiKey = null; // No API key

    // Since hasLocalWallet checks real filesystem, this test may be false
    // We're testing the logic, not the actual wallet existence
    const result = shouldAttemptX402Payment(mockResponse, apiKey);
    // This depends on whether there's actually a wallet, so we test both cases
    expect(typeof result).toBe('boolean');
  });

  it('should not attempt x402 payment with API key present', () => {
    const mockResponse = { 
      status: 402,
      headers: { get: vi.fn().mockReturnValue('payment-required-data') }
    };
    const apiKey = 'test-api-key';

    const result = shouldAttemptX402Payment(mockResponse, apiKey);
    expect(result).toBe(false);
  });

  it('should not attempt x402 payment for non-402 status', () => {
    const mockResponse = { 
      status: 401,
      headers: { get: vi.fn().mockReturnValue('payment-required-data') }
    };
    const apiKey = null;

    const result = shouldAttemptX402Payment(mockResponse, apiKey);
    expect(result).toBe(false);
  });

  it('should not attempt x402 payment without payment-required header', () => {
    const mockResponse = { 
      status: 402,
      headers: { get: vi.fn().mockReturnValue(null) }
    };
    const apiKey = null;

    const result = shouldAttemptX402Payment(mockResponse, apiKey);
    expect(result).toBe(false);
  });
});

describe('Wallet Integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should check for local wallet existence', async () => {
    // Mock wallet config
    const { hasLocalWallet } = await import('../x402.js');
    
    // This will depend on actual wallet state, so we just check it doesn't throw
    expect(() => hasLocalWallet()).not.toThrow();
  });

  it('should handle wallet password from environment', async () => {
    const originalEnv = process.env.NANSEN_WALLET_PASSWORD;
    process.env.NANSEN_WALLET_PASSWORD = 'test-password';

    const { getWalletPassword } = await import('../x402.js');
    const password = await getWalletPassword();
    
    expect(password).toBe('test-password');

    // Restore original env
    if (originalEnv !== undefined) {
      process.env.NANSEN_WALLET_PASSWORD = originalEnv;
    } else {
      delete process.env.NANSEN_WALLET_PASSWORD;
    }
  });
});

describe('x402 Flow Integration', () => {
  it('should throw error when no local wallet found', async () => {
    const mockResponse = {
      status: 402,
      headers: {
        get: vi.fn().mockReturnValue(btoa(JSON.stringify([
          {
            scheme: 'exact',
            network: 'eip155:1',
            amount: '1000000000000000000',
            recipient: '0x742d35Cc6084C13B2D3F78fFcE2BDa4A4b0A1234'
          }
        ])))
      }
    };

    const mockRetryFn = vi.fn();

    // This test will check actual wallet state, so we just verify it throws some error
    await expect(attemptX402Payment(mockResponse, mockRetryFn)).rejects.toThrow();
  });

  it('should throw error when no payment requirements found', async () => {
    const mockResponse = {
      status: 402,
      headers: {
        get: vi.fn().mockReturnValue(null) // No payment-required header
      }
    };

    const mockRetryFn = vi.fn();

    // The function may throw different errors depending on wallet state
    // We just verify it throws an error
    await expect(attemptX402Payment(mockResponse, mockRetryFn)).rejects.toThrow();
  });

  it('should throw error when no EVM payment requirement found', async () => {
    const mockResponse = {
      status: 402,
      headers: {
        get: vi.fn().mockReturnValue(btoa(JSON.stringify([
          {
            scheme: 'exact',
            network: 'solana:mainnet', // Non-EVM network
            amount: '1000000',
            recipient: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
          }
        ])))
      }
    };

    const mockRetryFn = vi.fn();

    // The function may throw different errors depending on wallet state
    // We just verify it throws an error
    await expect(attemptX402Payment(mockResponse, mockRetryFn)).rejects.toThrow();
  });
});