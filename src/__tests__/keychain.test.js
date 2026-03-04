/**
 * Tests for keychain module
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted ensures these are available when vi.mock factories run (hoisted above imports)
const { mockPlatform, mockExecFileSync } = vi.hoisted(() => ({
  mockPlatform: vi.fn(() => 'darwin'),
  mockExecFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return {
    ...actual,
    default: { ...actual, platform: mockPlatform },
    platform: mockPlatform,
  };
});

import { keychainAvailable, keychainStore, keychainGet, keychainDelete } from '../keychain.js';

describe('keychainAvailable()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true on macOS (darwin)', () => {
    mockPlatform.mockReturnValue('darwin');
    expect(keychainAvailable()).toBe(true);
  });

  it('returns true on Linux when secret-tool is available', () => {
    mockPlatform.mockReturnValue('linux');
    mockExecFileSync.mockReturnValue('/usr/bin/secret-tool\n');
    expect(keychainAvailable()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith('which', ['secret-tool'], expect.any(Object));
  });

  it('returns false on Linux when secret-tool is missing', () => {
    mockPlatform.mockReturnValue('linux');
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    expect(keychainAvailable()).toBe(false);
  });

  it('returns false on Windows', () => {
    mockPlatform.mockReturnValue('win32');
    expect(keychainAvailable()).toBe(false);
  });

  it('returns false on unsupported platform', () => {
    mockPlatform.mockReturnValue('freebsd');
    expect(keychainAvailable()).toBe(false);
  });
});

describe('keychainStore()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls macOS security command with correct args', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockExecFileSync.mockReturnValue('');

    const result = await keychainStore('my-secret-password');
    expect(result).toEqual({ backend: 'keychain-macos' });
    expect(mockExecFileSync).toHaveBeenCalledWith('security', [
      'add-generic-password',
      '-U',
      '-s', 'nansen-cli',
      '-a', 'wallet-password',
      '-w', 'my-secret-password',
    ], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('calls Linux secret-tool with correct args', async () => {
    mockPlatform.mockReturnValue('linux');
    mockExecFileSync.mockReturnValue('');

    const result = await keychainStore('linux-secret');
    expect(result).toEqual({ backend: 'keychain-linux' });
    expect(mockExecFileSync).toHaveBeenCalledWith('secret-tool', [
      'store',
      '--label', 'nansen-cli',
      'service', 'nansen-cli',
      'account', 'wallet-password',
    ], expect.objectContaining({ encoding: 'utf8', input: 'linux-secret' }));
  });

  it('throws on unsupported platform', async () => {
    mockPlatform.mockReturnValue('win32');
    await expect(keychainStore('pw')).rejects.toThrow('not supported');
  });

  it('throws on macOS security command failure', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockExecFileSync.mockImplementation(() => { throw new Error('Keychain locked'); });
    await expect(keychainStore('pw')).rejects.toThrow('Keychain locked');
  });
});

describe('keychainGet()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns trimmed password from macOS keychain', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockExecFileSync.mockReturnValue('my-password\n');

    const result = await keychainGet();
    expect(result).toBe('my-password');
    expect(mockExecFileSync).toHaveBeenCalledWith('security', [
      'find-generic-password',
      '-s', 'nansen-cli',
      '-a', 'wallet-password',
      '-w',
    ], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('returns trimmed password from Linux secret-tool', async () => {
    mockPlatform.mockReturnValue('linux');
    mockExecFileSync.mockReturnValue('linux-password\n');

    const result = await keychainGet();
    expect(result).toBe('linux-password');
  });

  it('returns null when macOS password not found (exit code 44)', async () => {
    mockPlatform.mockReturnValue('darwin');
    const err = new Error('security: SecKeychainSearchCopyNext');
    err.status = 44;
    mockExecFileSync.mockImplementation(() => { throw err; });

    const result = await keychainGet();
    expect(result).toBeNull();
  });

  it('returns null on Linux when not found', async () => {
    mockPlatform.mockReturnValue('linux');
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

    const result = await keychainGet();
    expect(result).toBeNull();
  });

  it('returns null on unsupported platform', async () => {
    mockPlatform.mockReturnValue('win32');
    const result = await keychainGet();
    expect(result).toBeNull();
  });
});

describe('keychainDelete()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls macOS delete command and never throws', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockExecFileSync.mockReturnValue('');

    await expect(keychainDelete()).resolves.toBeUndefined();
    expect(mockExecFileSync).toHaveBeenCalledWith('security', [
      'delete-generic-password',
      '-s', 'nansen-cli',
      '-a', 'wallet-password',
    ], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('calls Linux clear command', async () => {
    mockPlatform.mockReturnValue('linux');
    mockExecFileSync.mockReturnValue('');

    await expect(keychainDelete()).resolves.toBeUndefined();
    expect(mockExecFileSync).toHaveBeenCalledWith('secret-tool', [
      'clear',
      'service', 'nansen-cli',
      'account', 'wallet-password',
    ], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('never throws even if underlying command fails', async () => {
    mockPlatform.mockReturnValue('darwin');
    mockExecFileSync.mockImplementation(() => { throw new Error('item not found'); });

    await expect(keychainDelete()).resolves.toBeUndefined();
  });

  it('does nothing on unsupported platform and never throws', async () => {
    mockPlatform.mockReturnValue('win32');
    await expect(keychainDelete()).resolves.toBeUndefined();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
