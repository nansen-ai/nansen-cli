/**
 * `auth` and `doctor --offline` promise zero network activity. The help path
 * runs before command dispatch, so it has to honour the same contract — the
 * cost-map refresh fetches the OpenAPI spec and writes ~/.nansen/cost-map.json.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const refreshCostMapIfStale = vi.fn(async () => {});

vi.mock('../cost-cache.js', async (importOriginal) => ({
  ...(await importOriginal()),
  refreshCostMapIfStale,
}));

const scheduleUpdateCheck = vi.fn();

vi.mock('../update-check.js', async (importOriginal) => ({
  ...(await importOriginal()),
  scheduleUpdateCheck,
}));

const { runCLI } = await import('../cli.js');

function baseDeps() {
  return { output: () => {}, errorOutput: () => {}, exit: () => {} };
}

describe('offline commands: --help does not touch the network', () => {
  let fetchSpy;

  beforeEach(() => {
    refreshCostMapIfStale.mockClear();
    scheduleUpdateCheck.mockClear();
    fetchSpy = vi.fn(() => { throw new Error('network access in offline command'); });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('doctor --offline --help skips the cost-map refresh', async () => {
    await runCLI(['doctor', '--offline', '--help'], baseDeps());
    expect(refreshCostMapIfStale).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('auth --help skips the cost-map refresh', async () => {
    await runCLI(['auth', '--help'], baseDeps());
    expect(refreshCostMapIfStale).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('auth status --help skips the cost-map refresh', async () => {
    await runCLI(['auth', 'status', '--help'], baseDeps());
    expect(refreshCostMapIfStale).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('cache stats is fully offline', async () => {
    await runCLI(['cache', 'stats'], baseDeps());
    expect(refreshCostMapIfStale).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('doctor --help (online) still refreshes the cost map', async () => {
    await runCLI(['doctor', '--help'], baseDeps());
    expect(refreshCostMapIfStale).toHaveBeenCalledOnce();
  });

  // The top-level page and its topics print local text only: no update check
  // either (it spawns a child that contacts the npm registry).
  it.each([
    [[]],
    [['help']],
    [['--help']],
    [['help', 'chains']],
    [['help', 'nope']],
    [['not-a-command', '--help']],
  ])('top-level help %j does not schedule an update check', async (args) => {
    await runCLI(args, baseDeps());
    expect(scheduleUpdateCheck).not.toHaveBeenCalled();
  });

  it.each([
    [['research', 'smart-money', 'netflow', '--help']],
    [['help', 'trade']],
  ])('command help %j still schedules the update check', async (args) => {
    await runCLI(args, baseDeps());
    expect(scheduleUpdateCheck).toHaveBeenCalledOnce();
  });

  // The top-level page and its topics print no costs, so a cold or stale
  // cost map must not delay them with a spec fetch.
  it.each([
    [[]],
    [['help']],
    [['--help']],
    [['help', 'chains']],
    [['help', 'nope']],
    [['not-a-command', '--help']],
  ])('top-level help %j skips the cost-map refresh', async (args) => {
    await runCLI(args, baseDeps());
    expect(refreshCostMapIfStale).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('command help still refreshes the cost map, also through `help <command>`', async () => {
    await runCLI(['research', 'smart-money', 'netflow', '--help'], baseDeps());
    expect(refreshCostMapIfStale).toHaveBeenCalledOnce();
    refreshCostMapIfStale.mockClear();
    await runCLI(['help', 'research', 'smart-money', 'netflow'], baseDeps());
    expect(refreshCostMapIfStale).toHaveBeenCalledOnce();
  });
});
