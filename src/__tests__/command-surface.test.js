/**
 * Drift guard for the command surface users and agents read.
 *
 * `nansen --help` is the first — and often the only — place an agent looks, so a
 * subcommand that is wired in code but missing from the banner is effectively
 * undiscoverable. The same goes for README.md and `nansen schema`. These tests
 * fail when any of those descriptions falls behind the code.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildCommands, HELP } from '../cli.js';
import { buildWalletCommands, WALLET_SUBCOMMANDS } from '../wallet.js';

const repoRoot = path.resolve(process.cwd());
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'schema.json'), 'utf8'));
const walletSource = fs.readFileSync(path.join(repoRoot, 'src', 'wallet.js'), 'utf8');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

/**
 * `research` is a catalogue, not a short list: its banner line names the handful
 * of categories worth leading with, and the full set (including every
 * `historical-*` command) lives in `nansen schema research` and
 * `nansen research help`. Every other group must name all of its subcommands.
 */
const CURATED_HELP_GROUPS = new Set(['research']);

/** The COMMANDS: block of the banner, as { group: 'rest of the line' }. */
function helpCommandLines() {
  const block = HELP.split('COMMANDS:')[1].split('\n\n')[0];
  const lines = {};
  for (const line of block.split('\n')) {
    const match = line.match(/^ {2}([a-z][a-z-]*) {2,}(.*)$/);
    if (match) lines[match[1]] = match[2];
  }
  return lines;
}

/** Words of a description, split on everything a subcommand name cannot contain. */
function nameTokens(text) {
  return new Set(text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
}

/**
 * Names from a banner line that reads as a comma-separated list, e.g.
 * `Hyperliquid bridge: quote, execute, status (EVM <-> HL)`. Prose lines have
 * no such list and yield nothing.
 */
function listedNames(description) {
  const parts = description.split(':').pop().split(',')
    .map(part => part.trim().replace(/\s*\(.*$/, '').trim());
  if (parts.length < 2) return [];
  return parts.every(part => /^[a-z][a-z0-9-]*$/.test(part)) ? parts : [];
}

/** Subcommand keys of the wallet dispatcher, read straight out of the source. */
function walletHandlerKeys() {
  return [...walletSource.matchAll(/^\s{6,10}'([a-z][a-z-]*)':\s*async/gm)].map(m => m[1]);
}

/** Backticked names on a README line like `**Wallet:** \`create\`, \`list\` — ...`. */
function readmeGroupList(group) {
  const line = readme.split('\n').find(l => l.startsWith(`**${group}:**`));
  if (!line) return null;
  const listPart = line.split('—')[0];
  return [...listPart.matchAll(/`([a-z][a-z0-9-]*)`/g)].map(m => m[1]);
}

/**
 * The top-level `perp` command combines its trading schema with analytics that
 * live under `research.perp` in schema.json. Read that combined surface from
 * the runtime help instead of duplicating the two analytics aliases here.
 */
async function perpRuntimeNames() {
  const output = [];
  const commands = buildCommands({ log: line => output.push(line) });
  await commands.perp(['help'], null, {}, {});
  const block = output.join('\n').split('SUBCOMMANDS:')[1].split('\n\n')[0];
  return [...block.matchAll(/^ {2}([a-z][a-z0-9-]*)\s+/gm)]
    .map(match => match[1]);
}

describe('help banner covers the real command surface', () => {
  it('gives every command group in the schema a line in the banner', () => {
    const lines = helpCommandLines();
    for (const group of Object.keys(schema.commands)) {
      expect(lines[group], `"${group}" is in schema.json but missing from the --help banner`).toBeDefined();
    }
  });

  it('names every subcommand of a group on that group\'s banner line', () => {
    const lines = helpCommandLines();
    for (const [group, definition] of Object.entries(schema.commands)) {
      if (CURATED_HELP_GROUPS.has(group)) continue;
      const subcommands = Object.keys(definition.subcommands || {});
      const listed = nameTokens(lines[group] ?? '');
      const missing = subcommands.filter(name => !listed.has(name));
      expect(missing, `--help line for "${group}" does not mention: ${missing.join(', ')}`).toEqual([]);
    }
  });

  it('does not advertise a subcommand that no longer exists', async () => {
    const lines = helpCommandLines();
    for (const [group, definition] of Object.entries(schema.commands)) {
      const subcommands = Object.keys(definition.subcommands || {});
      if (group === 'perp') subcommands.push(...await perpRuntimeNames());
      if (!subcommands.length) continue;
      for (const name of listedNames(lines[group] ?? '')) {
        expect(
          subcommands.includes(name),
          `--help line for "${group}" lists "${name}", which is not a ${group} subcommand`
        ).toBe(true);
      }
    }
  });

  it('names every command shown by the combined `nansen perp help` surface', async () => {
    const runtimeNames = await perpRuntimeNames();
    const listed = nameTokens(helpCommandLines().perp ?? '');
    const missing = runtimeNames.filter(name => !listed.has(name));
    expect(missing, `--help line for "perp" does not mention: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('wallet subcommands stay in sync everywhere they are documented', () => {
  it('matches the dispatcher in src/wallet.js', () => {
    const handlers = walletHandlerKeys();
    expect(handlers.length).toBeGreaterThanOrEqual(WALLET_SUBCOMMANDS.length);
    // `help` is the fallback, not a capability, so it is not advertised.
    expect(handlers.filter(name => name !== 'help').sort()).toEqual([...WALLET_SUBCOMMANDS].sort());
    expect(handlers).toContain('help');
  });

  it('is listed in full on the --help banner', () => {
    const listed = nameTokens(helpCommandLines().wallet ?? '');
    for (const name of WALLET_SUBCOMMANDS) {
      expect(listed.has(name), `--help wallet line is missing "${name}"`).toBe(true);
    }
  });

  it('is listed in full in README.md', () => {
    expect(readmeGroupList('Wallet')).toEqual([...WALLET_SUBCOMMANDS]);
  });

  it('is listed in full by `nansen wallet help`', async () => {
    const output = [];
    const commands = buildWalletCommands({ log: line => output.push(line) });
    await commands.wallet(['help'], null, {}, {});
    const text = output.join('\n');
    for (const name of WALLET_SUBCOMMANDS) {
      expect(text, `\`nansen wallet help\` is missing "${name}"`).toContain(name);
    }
  });

  it('has a description and at least one example in the schema', () => {
    const subcommands = schema.commands.wallet.subcommands;
    expect(Object.keys(subcommands).sort()).toEqual([...WALLET_SUBCOMMANDS].sort());
    for (const name of WALLET_SUBCOMMANDS) {
      expect(subcommands[name].description, `schema wallet.${name} needs a description`).toBeTruthy();
      expect(subcommands[name].examples?.length, `schema wallet.${name} needs an example`).toBeGreaterThan(0);
      for (const example of subcommands[name].examples) {
        expect(example).toContain(`nansen wallet ${name}`);
      }
    }
  });
});

describe('README command lists stay in sync with the schema', () => {
  it('lists the same subcommands the schema declares', () => {
    for (const group of ['Trade', 'Wallet']) {
      const listed = readmeGroupList(group);
      expect(listed, `README has no "**${group}:**" list`).toBeTruthy();
      expect(listed.sort()).toEqual(Object.keys(schema.commands[group.toLowerCase()].subcommands).sort());
    }
  });
});
