import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { openAuthBrowser } from '../auth-browser.js';
describe('safe approval browser opening', () => {
  it.each(['darwin', 'linux', 'win32'])('passes only the public URL safely on %s', async platform => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdin.end = vi.fn(); child.kill = vi.fn();
    const spawnFn = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return child; });
    const url = 'https://idp.nansen.ai/device?user_code=ABCD-EFGH';
    expect(await openAuthBrowser(url, 'https://api.nansen.ai', { platform, spawnFn })).toBe(true);
    const [, args, options] = spawnFn.mock.calls[0];
    expect(options.shell).toBe(false);
    if (platform === 'win32') { expect(args.join(' ')).not.toContain(url); expect(child.stdin.end).toHaveBeenCalledWith(url); }
    else expect(args).toEqual([url]);
  });
  it('rejects a server-supplied foreign or secret-bearing URL before spawning', () => {
    const spawnFn = vi.fn();
    for (const url of ['https://evil.example/device', 'https://idp.nansen.ai/device?device_code=SECRET']) {
      expect(() => openAuthBrowser(url, 'https://api.nansen.ai', { spawnFn })).toThrow();
    }
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
