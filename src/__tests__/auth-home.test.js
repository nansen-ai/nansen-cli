import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { authDirectory, readAuthConfig } from '../auth-credentials.js';
afterEach(() => vi.restoreAllMocks());
it('uses the OS home when environment home paths are missing instead of the working directory', () => {
  const synthetic = path.join(os.tmpdir(), 'synthetic-auth-home');
  const home = vi.spyOn(os, 'homedir').mockReturnValue(synthetic);
  expect(authDirectory({})).toBe(path.join(synthetic, '.nansen'));
  expect(home).toHaveBeenCalledOnce();
  expect(authDirectory({ HOME: os.tmpdir() })).toBe(path.join(os.tmpdir(), '.nansen'));
  expect(authDirectory({ USERPROFILE: os.tmpdir() })).toBe(path.join(os.tmpdir(), '.nansen'));
  expect(home).toHaveBeenCalledOnce();
});
it.each(['', 'relative', null])('refuses unusable OS home %s before reading credential files', value => {
  vi.spyOn(os, 'homedir').mockReturnValue(value);
  const read = vi.spyOn(fs, 'existsSync');
  expect(() => readAuthConfig({})).toThrow(expect.objectContaining({ code: 'AUTH_HOME_UNAVAILABLE' }));
  expect(read).not.toHaveBeenCalled();
});
it('does not expose OS errors or accept an explicit relative home', () => {
  vi.spyOn(os, 'homedir').mockImplementation(() => { throw new Error('private OS detail'); });
  expect(() => authDirectory({})).toThrow('Set HOME or USERPROFILE');
  expect(() => authDirectory({ HOME: 'relative' })).toThrow(expect.objectContaining({ code: 'AUTH_HOME_UNAVAILABLE' }));
});
