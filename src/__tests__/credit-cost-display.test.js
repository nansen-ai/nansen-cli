/**
 * API-1121: credit costs the CLI prints in help and after a call.
 *
 * Fixtures copy the live spec at api.nansen.ai/openapi.json. The API prices
 * each endpoint once and only lifts a 0-credit endpoint to 1 for Free users,
 * so Free and Pro match everywhere except /api/v1/search/token-sectors. The
 * one real price change is premium_labels=true, which the spec publishes in
 * x-credit-cost-variants.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SPEC = {
  paths: {
    '/api/v1/tgm/holders': {
      post: {
        'x-credit-cost': { free: 5, pro: 5 },
        'x-credit-cost-variants': {
          'omitted or premium_labels=false (default)': { free: 5, pro: 5 },
          'premium_labels=true': { pro: 150 },
        },
      },
    },
    '/api/v1/search/token-sectors': { get: { 'x-credit-cost': { free: 1, pro: 0 } } },
    '/api/v1/agent/fast': { post: { 'x-credit-cost': { free: 200, pro: 200 } } },
    '/api/v1/agent/expert': { post: { 'x-credit-cost': { free: 750, pro: 750 } } },
  },
};

let tempDir;
let originalHome;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-api-1121-'));
  process.env.HOME = tempDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.HOME = originalHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Fill the cost cache the way the CLI does in production, by fetching the
// spec, then block the network for the rest of the test.
async function loadSpec(spec = SPEC) {
  fs.mkdirSync(path.join(tempDir, '.nansen'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, '.nansen', 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latest: '0.0.0' }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => spec }));
  const { refreshCostMapIfStale } = await import('../cost-cache.js');
  await refreshCostMapIfStale();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network call')));
}

const costLines = text => text.split('\n').filter(line => line.startsWith('Cost'));

describe('help cost lines', () => {
  it('prints one price when Free and Pro cost the same, then the premium-labels price', async () => {
    await loadSpec();
    const cli = await import('../cli.js');
    expect(costLines(cli.generateSubcommandHelp('token', 'holders'))).toEqual([
      'Cost: 5 credits',
      'Cost with --premium-labels: 150 credits (Pro tier only)',
    ]);
  });

  it('keeps both tiers when they differ', async () => {
    const { formatCost } = await import('../cost-cache.js');
    expect(formatCost({ free: 1, pro: 0 })).toBe('1 credit (Free tier) / 0 credits (Pro tier)');
  });

  it('names the API condition when the command has no matching flag', async () => {
    await loadSpec({
      paths: {
        '/api/v1/tgm/who-bought-sold': {
          post: {
            'x-credit-cost': { free: 1, pro: 1 },
            'x-credit-cost-variants': { 'premium_labels=true': { pro: 150 } },
          },
        },
      },
    });
    const cli = await import('../cli.js');
    expect(costLines(cli.generateSubcommandHelp('token', 'who-bought-sold'))).toEqual([
      'Cost: 1 credit',
      'Cost with premium_labels=true: 150 credits (Pro tier only)',
    ]);
  });
});

describe('agent help cost section', () => {
  it('prints one price per mode when Free and Pro cost the same', async () => {
    await loadSpec();
    const lines = [];
    const { buildAgentCommands } = await import('../commands/agent.js');
    await buildAgentCommands({ log: msg => lines.push(msg) }).agent([], null, { help: true }, {});
    const help = lines.join('\n');
    expect(help).toContain('fast:   200 credits\n');
    expect(help).toContain('expert: 750 credits\n');
    expect(help).not.toContain('Free tier');
  });
});

describe('estimated credits after a call with no cost header', () => {
  const run = async (endpoint, method) => {
    const cli = await import('../cli.js');
    const errors = [];
    await cli.runCLI(['research', 'token', 'holders', '--token', 'So11111111111111111111111111111111111111112', '--chain', 'solana'], {
      output: () => {},
      errorOutput: msg => errors.push(msg),
      exit: () => {},
      NansenAPIClass: function MockAPI() {
        this.lastResponseMeta = { credits: { used: 5, remaining: 100, cost: null } };
        this.lastEndpoint = endpoint;
        this[method] = vi.fn().mockResolvedValue({ data: [] });
        this.tokenHolders = vi.fn().mockResolvedValue({ data: [] });
      },
    });
    return errors.find(line => line.startsWith('Credits:'));
  };

  it('prints one estimate when Free and Pro cost the same', async () => {
    await loadSpec();
    expect(await run('/api/v1/tgm/holders', 'tokenHolders')).toBe('Credits: ~5 (estimated)');
  });

  it('keeps both estimates when they differ', async () => {
    await loadSpec();
    expect(await run('/api/v1/search/token-sectors', 'tokenSectors')).toBe('Credits: ~1 free / 0 pro (estimated)');
  });
});

describe('cost cache', () => {
  it('keeps the spec cost variants', async () => {
    await loadSpec();
    const { getCostVariants } = await import('../cost-cache.js');
    expect(getCostVariants('/api/v1/tgm/holders')).toEqual(SPEC.paths['/api/v1/tgm/holders'].post['x-credit-cost-variants']);
    expect(getCostVariants('/api/v1/agent/fast')).toBeNull();
  });
});
