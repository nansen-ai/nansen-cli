/**
 * Tests for x402 Solana payment functionality
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePaymentRequirements, createSolanaPaymentPayload } from '../x402-solana.js';

describe('x402 Solana Payment', () => {
  describe('parsePaymentRequirements', () => {
    it('should parse valid Solana payment requirements', () => {
      const mockResponse = {
        headers: new Map([
          ['payment-required', btoa(JSON.stringify({
            nonce: 'test-nonce-123',
            payments: [
              {
                network: 'solana:mainnet-beta',
                recipient: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
                amount: '1000000',
                token: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
                memo: 'API access payment'
              }
            ]
          }))]
        ])
      };
      mockResponse.headers.get = (key) => mockResponse.headers.get(key) || null;

      const result = parsePaymentRequirements(mockResponse);

      expect(result).toEqual({
        network: 'solana:mainnet-beta',
        recipient: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
        amount: '1000000',
        token: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
        memo: 'API access payment',
        nonce: 'test-nonce-123'
      });
    });

    it('should return null for non-Solana payment requirements', () => {
      const mockResponse = {
        headers: new Map([
          ['payment-required', btoa(JSON.stringify({
            payments: [
              {
                network: 'ethereum:mainnet',
                recipient: '0x1234567890123456789012345678901234567890',
                amount: '1000000000000000000'
              }
            ]
          }))]
        ])
      };
      mockResponse.headers.get = (key) => mockResponse.headers.get(key) || null;

      const result = parsePaymentRequirements(mockResponse);

      expect(result).toBeNull();
    });

    it('should return null when no payment-required header', () => {
      const mockResponse = {
        headers: new Map()
      };
      mockResponse.headers.get = (key) => mockResponse.headers.get(key) || null;

      const result = parsePaymentRequirements(mockResponse);

      expect(result).toBeNull();
    });

    it('should handle malformed payment requirements gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockResponse = {
        headers: new Map([
          ['payment-required', 'invalid-base64-json']
        ])
      };
      mockResponse.headers.get = (key) => mockResponse.headers.get(key) || null;

      const result = parsePaymentRequirements(mockResponse);

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to parse payment requirements:',
        expect.any(String)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('createSolanaPaymentPayload', () => {
    const mockKeypair = '0'.repeat(128); // 64-byte hex string (mock keypair)
    const mockRequirements = {
      network: 'solana:mainnet-beta',
      recipient: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
      amount: '1000000',
      token: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
      nonce: 'test-nonce-123'
    };

    it('should create a valid payment payload', () => {
      const payload = createSolanaPaymentPayload(mockRequirements, mockKeypair);

      expect(payload).toBeDefined();
      expect(typeof payload).toBe('string');

      // Decode and verify structure
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
      expect(decoded).toHaveProperty('scheme', 'exact');
      expect(decoded).toHaveProperty('network', 'solana:mainnet-beta');
      expect(decoded).toHaveProperty('transaction');
      expect(decoded).toHaveProperty('signature');
      expect(decoded).toHaveProperty('publicKey');
      expect(decoded).toHaveProperty('nonce', 'test-nonce-123');
    });

    it('should throw error for invalid requirements', () => {
      expect(() => {
        createSolanaPaymentPayload(null, mockKeypair);
      }).toThrow('Invalid payment requirements');

      expect(() => {
        createSolanaPaymentPayload({}, mockKeypair);
      }).toThrow('Invalid payment requirements');
    });

    it('should throw error for invalid keypair', () => {
      expect(() => {
        createSolanaPaymentPayload(mockRequirements, 'invalid-keypair');
      }).toThrow('Invalid Solana keypair - expected 64-byte hex string');

      expect(() => {
        createSolanaPaymentPayload(mockRequirements, '123456'); // too short
      }).toThrow('Invalid Solana keypair - expected 64-byte hex string');
    });

    it('should handle different nonce values', () => {
      const requirements1 = { ...mockRequirements, nonce: 'nonce-1' };
      const requirements2 = { ...mockRequirements, nonce: 'nonce-2' };

      const payload1 = createSolanaPaymentPayload(requirements1, mockKeypair);
      const payload2 = createSolanaPaymentPayload(requirements2, mockKeypair);

      const decoded1 = JSON.parse(Buffer.from(payload1, 'base64').toString());
      const decoded2 = JSON.parse(Buffer.from(payload2, 'base64').toString());

      expect(decoded1.nonce).toBe('nonce-1');
      expect(decoded2.nonce).toBe('nonce-2');
      expect(decoded1.transaction).not.toBe(decoded2.transaction); // Different nonces should create different transactions
    });
  });

  describe('integration', () => {
    it('should handle end-to-end payment flow', () => {
      // Mock 402 response
      const mock402Response = {
        status: 402,
        headers: new Map([
          ['payment-required', btoa(JSON.stringify({
            nonce: 'integration-test-123',
            payments: [
              {
                network: 'solana:mainnet-beta',
                recipient: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
                amount: '5000000', // 0.005 PAYAI
                token: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
                memo: 'Nansen API access'
              }
            ]
          }))]
        ])
      };
      mock402Response.headers.get = (key) => mock402Response.headers.get(key) || null;

      // Parse requirements
      const requirements = parsePaymentRequirements(mock402Response);
      expect(requirements).toBeDefined();
      expect(requirements.network).toBe('solana:mainnet-beta');

      // Create payment payload
      const mockKeypair = '1234567890abcdef'.repeat(8); // 64 bytes hex
      const payload = createSolanaPaymentPayload(requirements, mockKeypair);
      
      expect(payload).toBeDefined();
      expect(typeof payload).toBe('string');

      // Verify payload can be decoded
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
      expect(decoded.scheme).toBe('exact');
      expect(decoded.nonce).toBe('integration-test-123');
    });
  });
});