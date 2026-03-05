/**
 * Tests for keychain module (@napi-rs/keyring backend)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted ensures these are available when vi.mock factories run (hoisted above imports)
const { mockGetPassword, mockSetPassword, mockDeleteCredential, MockEntry } = vi.hoisted(() => {
  const mockGetPassword = vi.fn();
  const mockSetPassword = vi.fn();
  const mockDeleteCredential = vi.fn();
  // Must be a function (not arrow) so it can be used with `new`
  function MockEntry() {
    this.getPassword = mockGetPassword;
    this.setPassword = mockSetPassword;
    this.deleteCredential = mockDeleteCredential;
  }
  return { mockGetPassword, mockSetPassword, mockDeleteCredential, MockEntry: vi.fn(MockEntry) };
});

vi.mock('@napi-rs/keyring', () => ({
  Entry: MockEntry,
}));

import {
  keychainAvailable,
  keychainStore,
  keychainGet,
  keychainDelete,
  _resetForTesting,
} from '../keychain.js';

describe('keychainAvailable()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('returns true when keychain is available and entry exists', async () => {
    mockGetPassword.mockReturnValue('stored-password');
    expect(await keychainAvailable()).toBe(true);
    expect(MockEntry).toHaveBeenCalledWith('nansen-cli', 'wallet-password');
  });

  it('returns true when keychain is available but no entry stored (No matching entry)', async () => {
    mockGetPassword.mockImplementation(() => { throw new Error('No matching entry found'); });
    expect(await keychainAvailable()).toBe(true);
  });

  it('returns true when keychain is available but no entry stored (Item not found)', async () => {
    mockGetPassword.mockImplementation(() => { throw new Error('Item not found'); });
    expect(await keychainAvailable()).toBe(true);
  });

  it('returns true when keychain is available but no entry stored (not found)', async () => {
    mockGetPassword.mockImplementation(() => { throw new Error('The specified item could not be found'); });
    expect(await keychainAvailable()).toBe(true);
  });

  it('returns false when keychain system is broken (e.g. no D-Bus session)', async () => {
    mockGetPassword.mockImplementation(() => { throw new Error('Failed to connect to D-Bus session'); });
    expect(await keychainAvailable()).toBe(false);
  });
});

describe('keychainStore()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('calls Entry.setPassword with correct service/account and password', async () => {
    mockSetPassword.mockReturnValue(undefined);

    const result = await keychainStore('my-secret-password');
    expect(result).toEqual({ backend: 'keychain' });
    expect(MockEntry).toHaveBeenCalledWith('nansen-cli', 'wallet-password');
    expect(mockSetPassword).toHaveBeenCalledWith('my-secret-password');
  });

  it('throws when setPassword fails', async () => {
    mockSetPassword.mockImplementation(() => { throw new Error('Keychain locked'); });
    await expect(keychainStore('pw')).rejects.toThrow('Keychain locked');
  });
});

describe('keychainGet()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('returns password from Entry.getPassword', async () => {
    mockGetPassword.mockReturnValue('my-password');

    const result = await keychainGet();
    expect(result).toBe('my-password');
    expect(MockEntry).toHaveBeenCalledWith('nansen-cli', 'wallet-password');
    expect(mockGetPassword).toHaveBeenCalled();
  });

  it('returns null when password not found', async () => {
    mockGetPassword.mockImplementation(() => { throw new Error('No matching entry found'); });

    const result = await keychainGet();
    expect(result).toBeNull();
  });

  it('returns null when getPassword throws any error', async () => {
    mockGetPassword.mockImplementation(() => { throw new Error('Keychain access denied'); });

    const result = await keychainGet();
    expect(result).toBeNull();
  });
});

describe('keychainDelete()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();
  });

  it('calls Entry.deleteCredential', async () => {
    mockDeleteCredential.mockReturnValue(undefined);

    await expect(keychainDelete()).resolves.toBeUndefined();
    expect(MockEntry).toHaveBeenCalledWith('nansen-cli', 'wallet-password');
    expect(mockDeleteCredential).toHaveBeenCalled();
  });

  it('never throws even if deleteCredential throws', async () => {
    mockDeleteCredential.mockImplementation(() => { throw new Error('item not found'); });

    await expect(keychainDelete()).resolves.toBeUndefined();
  });
});
