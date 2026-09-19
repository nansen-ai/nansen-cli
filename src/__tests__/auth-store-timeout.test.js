import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { nativeStoreOperation } from '../auth-store.js';
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
it('fails bounded without claiming termination when the OS never reports helper close', async () => {
  vi.useFakeTimers();
  const stream = () => Object.assign(new EventEmitter(), { write: vi.fn(), resume: vi.fn(), destroy: vi.fn() });
  const child = Object.assign(new EventEmitter(), { stdin: stream(), stdout: stream(), stderr: stream(), kill: vi.fn().mockReturnValue(false), unref: vi.fn() });
  spawn.mockReturnValue(child);
  const result = nativeStoreOperation('set', '00000000-0000-4000-8000-000000000000.0', Buffer.from('synthetic-secret'), { directory: '/synthetic' }).catch(error => error);
  // Readiness precedes authority; before it, only the nonsecret directory goes out.
  expect(JSON.stringify(child.stdin.write.mock.calls)).not.toContain('c3ludGhldGljLXNlY3JldA==');
  child.stdout.emit('data', '{"ready":true}\n');
  expect(child.stdin.write).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(11000);
  expect(await result).toMatchObject({ code: 'AUTH_STORE_UNAVAILABLE' });
  expect(child.kill).toHaveBeenCalledWith('SIGKILL'); expect(child.unref).toHaveBeenCalledOnce();
  expect(child.stdin.destroy).toHaveBeenCalledOnce(); expect(child.stdout.destroy).toHaveBeenCalledOnce();
  // No late readiness can issue another operation after the failure deadline.
  child.stdout.emit('data', '{"ready":true}\n'); expect(child.stdin.write).toHaveBeenCalledTimes(2);
});
