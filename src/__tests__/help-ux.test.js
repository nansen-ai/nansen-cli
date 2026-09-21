/**
 * Help-UX plumbing: the three exported helpers behind agent-facing help and
 * option parsing that had no direct coverage of their own.
 *
 *   resolveBooleanOption   — tri-state `--flag` / `--flag true|false` parsing
 *   generateSubcommandHelp — every `nansen <cmd> <sub> --help` body
 *   changelog --since      — the version filter over CHANGELOG.md
 *
 * These are contract tests for text an agent reads and acts on, so they
 * assert the shape of the output (params, required marker, cost line,
 * example) rather than snapshotting whole strings, which would break on
 * every unrelated schema edit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveBooleanOption, parseArgs, generateSubcommandHelp, buildCommands, runCLI } from '../cli.js';

describe('valueless inline flag errors', () => {
  it('returns a structured non-zero error for --help=false', async () => {
    const output = vi.fn();
    const exit = vi.fn();

    const result = await runCLI(['--help=false'], { output, exit });

    expect(result).toMatchObject({
      type: 'error',
      data: { code: 'INVALID_PARAMS', error: '--help does not accept a value' },
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
      success: false,
      code: 'INVALID_PARAMS',
      error: '--help does not accept a value',
    });
  });
});

describe('resolveBooleanOption', () => {
  // How the value reaches the handler depends on parseArgs: a bare `--flag`
  // lands in `flags`, `--flag <value>` in `options`. Both spellings of an
  // explicit value are asserted directly (the string 'true' and the JSON
  // boolean true) so the helper's contract holds whichever one parseArgs
  // hands it.
  const viaArgs = (argv, key = 'premium-labels') => {
    const { flags, options } = parseArgs(argv);
    return resolveBooleanOption(options, flags, key);
  };

  it('reads a bare --flag as true', () => {
    expect(viaArgs(['--premium-labels'])).toBe(true);
    // Still true when another option follows, which is the shape a real
    // invocation has: `nansen research token holders --premium-labels --chain solana`.
    expect(viaArgs(['--premium-labels', '--chain', 'solana'])).toBe(true);
    expect(resolveBooleanOption({}, { 'premium-labels': true }, 'premium-labels')).toBe(true);
  });

  it('reads an explicit true value as true', () => {
    expect(viaArgs(['--premium-labels', 'true'])).toBe(true);
    expect(viaArgs(['--premium-labels', '1'])).toBe(true);
    expect(resolveBooleanOption({ 'premium-labels': 'true' }, {}, 'premium-labels')).toBe(true);
    expect(resolveBooleanOption({ 'premium-labels': true }, {}, 'premium-labels')).toBe(true);
  });

  it('reads an explicit false value as false, not as "flag present, so true"', () => {
    expect(viaArgs(['--premium-labels', 'false'])).toBe(false);
    expect(viaArgs(['--premium-labels', '0'])).toBe(false);
    expect(viaArgs(['--premium-labels=false'])).toBe(false);
    expect(resolveBooleanOption({ 'premium-labels': 'false' }, {}, 'premium-labels')).toBe(false);
    expect(resolveBooleanOption({ 'premium-labels': false }, {}, 'premium-labels')).toBe(false);
  });

  it('accepts true/false in any case', () => {
    expect(viaArgs(['--premium-labels', 'TRUE'])).toBe(true);
    expect(viaArgs(['--premium-labels', 'False'])).toBe(false);
  });

  it('returns undefined when the option was not supplied, so callers can fall back to the server default', () => {
    expect(viaArgs([])).toBeUndefined();
    expect(viaArgs(['--chain', 'solana'])).toBeUndefined();
    // Another boolean option being present must not leak into this key.
    expect(viaArgs(['--neg-risk', 'true'])).toBeUndefined();
    expect(resolveBooleanOption({}, {}, 'premium-labels')).toBeUndefined();
  });

  it('rejects an unrecognised or blank value instead of silently ignoring it', () => {
    for (const value of ['yes', 'no', 'on', 'off', '', '2']) {
      expect(() => resolveBooleanOption({ 'premium-labels': value }, {}, 'premium-labels'))
        .toThrow('--premium-labels must be true or false');
    }
    expect(() => viaArgs(['--premium-labels', 'yes']))
      .toThrow('--premium-labels must be true or false');
  });

  it('rejects repeated boolean values instead of falling back to the server default', () => {
    for (const argv of [
      ['--premium-labels', 'true', '--premium-labels', 'false'],
      ['--premium-labels=true', '--premium-labels=false'],
      ['--premium-labels', '--premium-labels'],
      ['--premium-labels', '--premium-labels', 'false'],
    ]) {
      expect(() => viaArgs(argv)).toThrow('--premium-labels cannot be repeated');
    }
  });

  it('preserves --flag=false through a real command handler', async () => {
    const api = { pmMarketScreener: vi.fn(async () => ({ data: [] })) };
    const { _: args, flags, options } = parseArgs(['market-screener', '--neg-risk=false']);
    await buildCommands({})['prediction-market'](args, api, flags, options);

    expect(api.pmMarketScreener).toHaveBeenCalledWith(
      expect.objectContaining({ negRisk: false })
    );
  });

  it('rejects a malformed boolean before the command calls the API', async () => {
    const api = { pmMarketScreener: vi.fn(async () => ({ data: [] })) };
    const { _: args, flags, options } = parseArgs(['market-screener', '--neg-risk=yes']);

    await expect(buildCommands({})['prediction-market'](args, api, flags, options))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS', message: '--neg-risk must be true or false' });
    expect(api.pmMarketScreener).not.toHaveBeenCalled();
  });
});

describe('generateSubcommandHelp', () => {
  // `token who-bought-sold` exercises every branch in one body: a required
  // option, a defaulted option, an enum option, an endpoint (cost line), and
  // no hand-written example (so the example is generated).
  const helpLines = (...args) => generateSubcommandHelp(...args).split('\n');
  const lineStartingWith = (lines, prefix) => lines.find(l => l.startsWith(prefix));

  it('opens with the subcommand name and its description', () => {
    const [first] = helpLines('token', 'who-bought-sold');
    expect(first).toMatch(/^token who-bought-sold — /);
    expect(first).toContain('Recent buyers and sellers');
  });

  it('lists every option, marking required ones and showing defaults and enums', () => {
    const params = lineStartingWith(helpLines('token', 'who-bought-sold'), 'Params');
    expect(params).toBe(
      'Params (* required): --chain (solana), --token*, --days (30), --buy-or-sell (BUY) [BUY|SELL]'
    );
    // The marker is what tells an agent which options it must supply, so
    // pin it per option rather than only on the joined line.
    expect(params).toContain('--token*');
    expect(params).not.toContain('--chain*');
  });

  it('generates a runnable example that already carries every required option', () => {
    const example = lineStartingWith(helpLines('token', 'who-bought-sold'), 'Example:');
    expect(example).toBe('Example: nansen research token who-bought-sold --token 0x... --chain solana');
  });

  it('uses the schema example verbatim when one exists, and lists the returned fields', () => {
    const lines = helpLines('auth', 'status');
    expect(lineStartingWith(lines, 'Returns:')).toContain('Returns: logged_in, api_key.present');
    // Hand-written examples are copied as-is: no required options or
    // `--chain` are appended on top of them.
    expect(lines[lines.length - 1]).toBe('Example: nansen auth status --pretty');
  });

  it('points the example at the current command path for commands that moved under research', () => {
    expect(lineStartingWith(helpLines('token', 'holders'), 'Example:'))
      .toContain('nansen research token holders');
    // A caller-supplied prefix wins, which is how `research <alias> <sub> --help` renders.
    expect(lineStartingWith(helpLines('token', 'holders', 'research tgm'), 'Example:'))
      .toContain('nansen research tgm holders');
    // Commands that never moved keep their own name.
    expect(lineStartingWith(helpLines('mcp', 'install'), 'Example:'))
      .toBe('Example: nansen mcp install claude-code');
  });

  it('returns null for an unknown command or subcommand so callers can fall through', () => {
    expect(generateSubcommandHelp('token', 'not-a-subcommand')).toBeNull();
    expect(generateSubcommandHelp('not-a-command', 'holders')).toBeNull();
  });

  it('finds a subcommand that only exists under the research category sharing the command name', () => {
    // `perp` names both the top-level trading command and a research
    // category, and they hold different subcommands. Looking only at the
    // trading command left the research ones with no help at all.
    const lines = helpLines('perp', 'screener', 'research perp');
    expect(lines[0]).toMatch(/^perp screener — /);
    expect(lineStartingWith(lines, 'Params')).toContain('--days (30)');
    expect(lineStartingWith(lines, 'Example:')).toBe('Example: nansen research perp screener');
    // ...and the trading command's own subcommands still resolve to the
    // trading schema, not to the research category.
    expect(lineStartingWith(helpLines('perp', 'order'), 'Params')).toContain('--coin*');
  });

  it('points a research-category subcommand at its research path even with no prefix given', () => {
    expect(lineStartingWith(helpLines('perp', 'leaderboard'), 'Example:'))
      .toBe('Example: nansen research perp leaderboard');
  });

  describe('credit cost line and --help rendering', () => {
    // The cost map is read from ~/.nansen at import time, so each case gets a
    // fresh HOME and a fresh module graph (same pattern as cost-cache.test.js).
    let tempDir;
    let originalHome;

    beforeEach(() => {
      originalHome = process.env.HOME;
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-help-ux-'));
      process.env.HOME = tempDir;
      vi.resetModules();
    });

    afterEach(() => {
      process.env.HOME = originalHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const seedCosts = costs => {
      const dir = path.join(tempDir, '.nansen');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cost-map.json'), JSON.stringify({ costs, fetchedAt: Date.now() }));
    };

    const freshHelp = async (...args) => {
      const cli = await import('../cli.js');
      return cli.generateSubcommandHelp(...args);
    };

    it('reports the cached per-tier cost for the endpoint the subcommand calls', async () => {
      seedCosts({ '/api/v1/tgm/who-bought-sold': { free: 3, pro: 5 } });
      const help = await freshHelp('token', 'who-bought-sold');
      expect(help).toContain('Cost: 3 credits (Free tier) / 5 credits (Pro tier)');
    });

    it('says "credit", not "credits", for a single credit', async () => {
      seedCosts({ '/api/v1/tgm/who-bought-sold': { free: 1, pro: 1 } });
      const help = await freshHelp('token', 'who-bought-sold');
      expect(help).toContain('Cost: 1 credit (Free tier) / 1 credit (Pro tier)');
    });

    it('omits the cost line entirely when no cost is known, rather than printing a blank one', async () => {
      const help = await freshHelp('token', 'who-bought-sold');
      expect(help).not.toContain('Cost:');
      // The rest of the help is unaffected.
      expect(help).toContain('Params (* required): --chain (solana), --token*');
    });

    // Drives the real `--help` path. Staying offline is the seeded caches'
    // job: a fresh update-check cache stops the background notifier spawning,
    // and the cost map each caller seeds first stops the inline spec fetch the
    // help path awaits on a cold cache. The fetch stub is belt and braces,
    // installed before the dynamic import so a stray request — at import time
    // or call time — is recorded and fails the assertion below rather than
    // escaping to the network.
    const runHelp = async argv => {
      fs.mkdirSync(path.join(tempDir, '.nansen'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.nansen', 'update-check.json'),
        JSON.stringify({ checkedAt: Date.now(), latest: '0.0.0' })
      );
      const fetchSpy = vi.fn().mockRejectedValue(new Error('Unexpected network call'));
      vi.stubGlobal('fetch', fetchSpy);
      try {
        const cli = await import('../cli.js');
        const outputs = [];
        await cli.runCLI(argv, {
          output: msg => outputs.push(msg),
          errorOutput: () => {},
          exit: () => {},
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        return outputs.join('\n');
      } finally {
        vi.unstubAllGlobals();
      }
    };

    it('prints the deprecation note above the generated body for a moved command', async () => {
      seedCosts({ '/api/v1/smart-money/netflow': { free: 5, pro: 5 } });
      const combined = await runHelp(['smart-money', 'netflow', '--help']);
      // The note, and then the real help body — the body is the part an
      // agent needs, and it used to go unasserted.
      expect(combined).toContain('"nansen smart-money" is deprecated');
      expect(combined).toContain('smart-money netflow — Net capital flows');
      expect(combined).toContain('Params (* required): --chain (solana)');
      expect(combined).toContain('Cost: 5 credits (Free tier) / 5 credits (Pro tier)');
      expect(combined).toContain('Example: nansen research smart-money netflow --chain solana');
    });

    it('answers a research subcommand help request with that subcommand, not with the category listing', async () => {
      seedCosts({ '/api/v1/perp-screener': { free: 1, pro: 1 } });
      const combined = await runHelp(['research', 'perp', 'screener', '--help']);
      expect(combined).toContain('perp screener — Screen perpetual futures contracts');
      expect(combined).toContain('Params (* required): --days (30)');
      expect(combined).toContain('Example: nansen research perp screener');
      // The old output was the category listing, which pointed the caller
      // back at the command they had just run.
      expect(combined).not.toContain('Use: nansen research perp <subcommand> --help');
    });
  });
});

describe('changelog --since filtering', () => {
  // A synthetic changelog keeps the assertions exact and stops the real
  // CHANGELOG.md's contents from dating these tests every release.
  const CHANGELOG = [
    '# Changelog',
    '',
    '## 1.11.0',
    '',
    '- Added the newest thing',
    '',
    '## [1.10.0] - 2026-01-02',
    '',
    '- Fixed the double-digit thing',
    '',
    '## 1.9.0',
    '',
    '- Fixed an older thing',
    '',
    '## 1.2.0',
    '',
    '- The oldest thing',
    '',
  ].join('\n');

  beforeEach(() => {
    const realReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
      if (String(file).endsWith('CHANGELOG.md')) return CHANGELOG;
      return realReadFileSync(file, ...rest);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runChangelog = options => {
    const logs = [];
    const commands = buildCommands({ log: m => logs.push(m), exit: vi.fn() });
    return commands.changelog([], null, {}, options).then(() => logs.join('\n'));
  };

  it('parses the conventional --since=<version> spelling as an option value', () => {
    const parsed = parseArgs(['changelog', '--since=1.10.0']);
    expect(parsed.options.since).toBe('1.10.0');
    expect(parsed.flags).not.toHaveProperty('since=1.10.0');
  });

  it('keeps the requested version and everything newer, and drops everything older', async () => {
    const out = await runChangelog({ since: '1.10.0' });

    expect(out).toContain('## 1.11.0');
    expect(out).toContain('Added the newest thing');
    // The boundary version itself is included — the filter is >=, not >.
    expect(out).toContain('## [1.10.0] - 2026-01-02');
    expect(out).toContain('Fixed the double-digit thing');

    expect(out).not.toContain('## 1.9.0');
    expect(out).not.toContain('Fixed an older thing');
    expect(out).not.toContain('## 1.2.0');
    expect(out).not.toContain('The oldest thing');
    // Preamble before the first release heading is not part of any entry.
    expect(out).not.toContain('# Changelog');
  });

  it('orders versions numerically, so 1.10.0 survives a --since of 1.9.0', async () => {
    const out = await runChangelog({ since: '1.9.0' });

    // A string comparison would rank '1.10.0' below '1.9.0' and drop the
    // newer entry — the failure mode this asserts against.
    expect(out).toContain('## [1.10.0] - 2026-01-02');
    expect(out).toContain('## 1.11.0');
    expect(out).toContain('## 1.9.0');
    expect(out).not.toContain('## 1.2.0');
  });

  it('treats a major.minor --since as its .0 patch release', async () => {
    const [partial, explicit] = await Promise.all([
      runChangelog({ since: '1.10' }),
      runChangelog({ since: '1.10.0' }),
    ]);
    expect(partial).toBe(explicit);
    expect(partial).toContain('## [1.10.0] - 2026-01-02');
  });

  it('keeps only the newest entry when --since names it', async () => {
    const out = await runChangelog({ since: '1.11.0' });
    expect(out.startsWith('## 1.11.0')).toBe(true);
    expect(out).toContain('Added the newest thing');
    expect(out).not.toContain('1.10.0');
  });

  it('prints every entry, header included, when --since is absent', async () => {
    const out = await runChangelog({});
    expect(out).toBe(CHANGELOG);
  });

  it('rejects a pre-release --since with an actionable message instead of guessing', async () => {
    // Version comparison here is major.minor.patch only; a pre-release tag
    // cannot be ordered, so it is refused rather than silently read as its
    // release version.
    await expect(runChangelog({ since: '1.11.0-beta.1' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'Invalid --since value "1.11.0-beta.1": expected a version like 1.43 or 1.43.0.',
    });
  });
});
