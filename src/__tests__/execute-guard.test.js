/**
 * --dry-run / --yes gate on `trade execute` (the bridge half lives in
 * bridge-execute-guard.test.js, which mocks trading.js wholesale).
 *
 * The guarantee under test: a dry run and a declined confirmation reach NO
 * signing and NO broadcast. The broadcast seam throws when it must not run,
 * and the dry-run fixtures deliberately have no wallet and no wallet password,
 * so any path that tried to sign would fail loudly rather than pass silently.
 * Nothing here touches a real network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

import {
  formatPlan,
  guardExecution,
  isYesEnvSet,
  resolveExecuteGuard,
} from '../execute-guard.js';
import { buildTradeExecutionPlan, buildTradingCommands, evmTxHash, saveQuote } from '../trading.js';
import { parseArgs, promptForConfirmation, runCLI } from '../cli.js';
import { createWallet, showWallet } from '../wallet.js';

const BASE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const LIFI_ROUTER = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae';

describe('execute guard flags', () => {
  it('reads --dry-run, --yes and -y off the parsed flags', () => {
    expect(resolveExecuteGuard({}, { env: {}, isTTY: false })).toEqual({
      dryRun: false, assumeYes: false, isTTY: false,
    });
    expect(resolveExecuteGuard({ 'dry-run': true }, { env: {}, isTTY: true }).dryRun).toBe(true);
    expect(resolveExecuteGuard({ yes: true }, { env: {} }).assumeYes).toBe(true);
    expect(resolveExecuteGuard({ y: true }, { env: {} }).assumeYes).toBe(true);
  });

  it('treats NANSEN_YES like --yes, and ignores unset/false values', () => {
    expect(isYesEnvSet({ NANSEN_YES: '1' })).toBe(true);
    expect(isYesEnvSet({ NANSEN_YES: 'true' })).toBe(true);
    expect(isYesEnvSet({ NANSEN_YES: 'YES' })).toBe(true);
    expect(isYesEnvSet({ NANSEN_YES: ' yes ' })).toBe(true);
    expect(isYesEnvSet({ NANSEN_YES: '0' })).toBe(false);
    expect(isYesEnvSet({ NANSEN_YES: 'false' })).toBe(false);
    expect(isYesEnvSet({ NANSEN_YES: 'off' })).toBe(false);
    expect(isYesEnvSet({ NANSEN_YES: '2' })).toBe(false);
    expect(isYesEnvSet({ NANSEN_YES: 'definitely' })).toBe(false);
    expect(isYesEnvSet({ NANSEN_YES: '' })).toBe(false);
    expect(isYesEnvSet({})).toBe(false);
    expect(resolveExecuteGuard({}, { env: { NANSEN_YES: '1' } }).assumeYes).toBe(true);
  });

  it('parses --yes as a switch, leaving the following argument alone', () => {
    const { flags, options } = parseArgs(['trade', 'execute', '--yes', '--quote', 'q1']);
    expect(flags.yes).toBe(true);
    expect(options.quote).toBe('q1');

    const short = parseArgs(['trade', 'execute', '-y', '--quote', 'q1']);
    expect(short.flags.y).toBe(true);
    expect(short.options.quote).toBe('q1');

    // Assignment syntax is invalid for valueless switches. Main's strict
    // parser must reject it rather than silently treating it as consent.
    expect(() => parseArgs(['trade', 'execute', '--yes=false', '--quote', 'q1']))
      .toThrow('--yes does not accept a value');
  });

  it('drops empty rows from a plan and aligns the rest', () => {
    const plan = formatPlan('Trade plan', [['Quote', 'q1'], ['Recipient', null], ['Fee', '$1']]);
    expect(plan).toContain('Quote:');
    expect(plan).toContain('Fee:');
    expect(plan).not.toContain('Recipient');
  });
});

describe('guardExecution', () => {
  const plan = '\n  Trade plan\n    Quote:  q1';

  it('prints the plan and stops on --dry-run without prompting', async () => {
    const logs = [];
    const promptFn = vi.fn();
    const proceed = await guardExecution({
      plan, dryRun: true, isTTY: true, promptFn, log: m => logs.push(m),
    });

    expect(proceed).toBe(false);
    expect(promptFn).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('DRY RUN — nothing was broadcast');
  });

  it('never prompts when stdin is not a terminal', async () => {
    const promptFn = vi.fn();
    expect(await guardExecution({ plan, isTTY: false, promptFn, log: () => {} })).toBe(true);
    expect(promptFn).not.toHaveBeenCalled();
  });

  it('never prompts when --yes is passed on a terminal', async () => {
    const promptFn = vi.fn();
    expect(await guardExecution({ plan, isTTY: true, assumeYes: true, promptFn, log: () => {} })).toBe(true);
    expect(promptFn).not.toHaveBeenCalled();
  });

  it('accepts y/yes (any case) and aborts on anything else', async () => {
    for (const answer of ['y', 'Y', 'yes', ' YES ']) {
      const promptFn = vi.fn(async () => answer);
      expect(await guardExecution({ plan, isTTY: true, promptFn, log: () => {} })).toBe(true);
    }
    for (const answer of ['', 'n', 'no', 'later', undefined]) {
      const promptFn = vi.fn(async () => answer);
      await expect(guardExecution({ plan, isTTY: true, promptFn, log: () => {} }))
        .rejects.toMatchObject({ code: 'CONFIRMATION_DECLINED' });
    }
  });

  it('tells the aborting user how to skip the prompt next time', async () => {
    const confirmationLogs = [];
    let caught;
    try {
      await guardExecution({
        plan,
        isTTY: true,
        promptFn: async () => 'n',
        log: () => {},
        confirmationLog: message => confirmationLogs.push(message),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'CONFIRMATION_DECLINED', reported: true });
    expect(caught.message).toMatch(/--yes.*NANSEN_YES=1.*--dry-run/s);
    expect(confirmationLogs).toHaveLength(2);
    expect(confirmationLogs[1]).toBe(caught.message);
  });

  it('fails closed when the prompt throws', async () => {
    await expect(guardExecution({
      plan,
      isTTY: true,
      promptFn: async () => { throw new Error('terminal unavailable'); },
      log: () => {},
    })).rejects.toThrow('terminal unavailable');
  });

  it('fails closed instead of hanging when stdin reaches EOF', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = promptForConfirmation('Continue? ', { input, output });
    input.end();
    await expect(answer).resolves.toBe('');
  });

  it('refuses an interactive execution when no CLI prompt was injected', async () => {
    await expect(guardExecution({ plan, isTTY: true, log: () => {} }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_UNAVAILABLE' });
  });
});

// ── trade execute ────────────────────────────────────────────────────────
//
// The trade fixtures deliberately run with NO wallet and NO wallet password
// unless a test creates them: any path that tries to sign fails loudly, so a
// dry run or a declined confirmation cannot pass by accident.

describe('trade execute --dry-run / --yes', () => {
  let tmpHome;
  let prevHome;
  let executeBodies;
  let api;

  function stubFetch({ allowBroadcast = false, allowance = null, callResult = '0x' } = {}) {
    executeBodies = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url, opts) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      const body = opts?.body ? JSON.parse(opts.body) : {};

      if (urlStr.includes('trading-api') && urlStr.endsWith('/execute')) {
        executeBodies.push(body);
        if (!allowBroadcast) throw new Error('broadcast must not be reached');
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({
            status: 'Success',
            chainType: 'evm',
            broadcaster: 'test',
            txHash: evmTxHash(body.signedTransaction),
          })),
        });
      }

      const rpc = result => Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: body.id || 1, result })),
      });
      if (body.method === 'eth_getCode') return rpc('0x6080604052');
      if (body.method === 'eth_call') {
        const data = body.params?.[0]?.data || '';
        if (allowance != null && data.startsWith('0xdd62ed3e')) {
          return rpc('0x' + BigInt(allowance).toString(16).padStart(64, '0'));
        }
        return rpc(callResult);
      }
      if (body.method === 'eth_getTransactionCount') return rpc('0x5');
      if (body.method === 'eth_getTransactionReceipt') return rpc({ status: '0x1', blockNumber: '0x100' });
      return rpc(null);
    }));
  }

  function nativeQuote(walletAddress) {
    return saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_ETH,
        outputMint: BASE_USDC,
        inAmount: '1000000000000000000',
        inputAmount: '1000000000000000000',
        outAmount: '3000000000',
        networkFeeInUsd: '0.02',
        transaction: {
          to: LIFI_ROUTER,
          data: '0x12345678',
          value: '1000000000000000000',
          gas: '100000',
          maxFeePerGas: '1000000',
          maxPriorityFeePerGas: '1000000',
        },
      }],
    }, 'base', 'local', null, null, {
      swapMode: 'exactIn',
      slippage: 0.03,
      request: {
        chain: 'base',
        toChain: null,
        walletAddress,
        recipient: null,
        fromToken: BASE_ETH,
        toToken: BASE_USDC,
        swapMode: 'exactIn',
        amount: '1000000000000000000',
        maxInputAmount: '1000000000000000000',
      },
    });
  }

  function erc20Quote(walletAddress) {
    return saveQuote({
      success: true,
      quotes: [{
        aggregator: 'lifi',
        inputMint: BASE_USDC,
        outputMint: BASE_ETH,
        inAmount: '1000000',
        inputAmount: '1000000',
        outAmount: '440000000000000',
        approvalAddress: LIFI_ROUTER,
        transaction: {
          to: LIFI_ROUTER,
          data: '0xdeadbeef',
          value: '0',
          gas: '100000',
          maxFeePerGas: '1000000',
          maxPriorityFeePerGas: '1000000',
        },
      }],
    }, 'base', 'local', null, null, {
      swapMode: 'exactIn',
      slippage: 0.03,
      request: {
        chain: 'base',
        toChain: null,
        walletAddress,
        recipient: null,
        fromToken: BASE_USDC,
        toToken: BASE_ETH,
        swapMode: 'exactIn',
        amount: '1000000',
        maxInputAmount: '1000000',
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-execute-guard-'));
    process.env.HOME = tmpHome;
    delete process.env.NANSEN_WALLET_PASSWORD;
    delete process.env.NANSEN_YES;
    api = {
      baseUrl: 'https://api.nansen.ai',
      selection: { kind: 'session' },
      requestCredentials: vi.fn(async () => ({ Authorization: 'Bearer selected-test-session' })),
      request: vi.fn(async (_endpoint, body) => ({
        results: body.addresses.map(address => ({ address, sanctioned: false })),
      })),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env.HOME = prevHome;
    delete process.env.NANSEN_WALLET_PASSWORD;
    delete process.env.NANSEN_YES;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('--dry-run validates, prints the plan and never signs or broadcasts', async () => {
    stubFetch();
    // No wallet and no password exist: every signing path below this gate
    // would throw NO_WALLET / PASSWORD_REQUIRED if it were reached.
    const quoteId = nativeQuote('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');

    const logs = [];
    const promptFn = vi.fn();
    const cmds = buildTradingCommands({ log: m => logs.push(m), promptFn, isTTY: true, env: {} });
    await cmds.execute([], api, { 'dry-run': true }, { quote: quoteId });

    const out = logs.join('\n');
    expect(out).toContain('Trade plan — Base');
    expect(out).toContain(quoteId);
    expect(out).toContain('1000000000000000000 base units');
    expect(out).toContain('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    expect(out).toContain('DRY RUN — nothing was broadcast');
    expect(executeBodies).toHaveLength(0);
    expect(promptFn).not.toHaveBeenCalled();
    expect(api.requestCredentials).toHaveBeenCalledOnce();
    const simulation = fetch.mock.calls.find(([url]) => String(url).includes('/simulate-swap'));
    expect(simulation[1].headers.Authorization).toBe('Bearer selected-test-session');
    expect(simulation[1].headers.apikey).toBeUndefined();
    expect(simulation[1].redirect).toBe('error');
    for (const [url, options] of fetch.mock.calls) {
      if (!String(url).includes('/simulate-swap')) expect(options.headers?.Authorization).toBeUndefined();
    }
  });

  it('--dry-run leaves the quote reusable', async () => {
    stubFetch();
    const quoteId = nativeQuote('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    const cmds = buildTradingCommands({ log: () => {}, promptFn: vi.fn(), isTTY: false, env: {} });

    await cmds.execute([], api, { 'dry-run': true }, { quote: quoteId });

    const saved = JSON.parse(fs.readFileSync(path.join(tmpHome, '.nansen', 'quotes', `${quoteId}.json`), 'utf8'));
    expect(saved.executedAt).toBeUndefined();
    expect(saved.broadcasts).toBeUndefined();
  });

  it('--dry-run validates every signer type without resolving signing credentials', async () => {
    stubFetch();
    const quoteId = nativeQuote('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    const quotePath = path.join(tmpHome, '.nansen', 'quotes', `${quoteId}.json`);
    const cmds = buildTradingCommands({ log: () => {}, isTTY: false, env: {} });

    for (const signerType of ['local', 'privy', 'walletconnect']) {
      const saved = JSON.parse(fs.readFileSync(quotePath, 'utf8'));
      saved.signerType = signerType;
      fs.writeFileSync(quotePath, JSON.stringify(saved, null, 2));
      await expect(cmds.execute([], api, { 'dry-run': true }, { quote: quoteId }))
        .resolves.toBeUndefined();
    }

    expect(executeBodies).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(quotePath, 'utf8')).executedAt).toBeUndefined();
  });

  it('--dry-run rejects a quote that exceeds the persisted request before reporting success', async () => {
    stubFetch();
    const quoteId = nativeQuote('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    const quotePath = path.join(tmpHome, '.nansen', 'quotes', `${quoteId}.json`);
    const saved = JSON.parse(fs.readFileSync(quotePath, 'utf8'));
    saved.response.quotes[0].inAmount = '2000000000000000000';
    saved.response.quotes[0].inputAmount = '2000000000000000000';
    saved.response.quotes[0].transaction.value = '2000000000000000000';
    fs.writeFileSync(quotePath, JSON.stringify(saved, null, 2));

    const logs = [];
    const cmds = buildTradingCommands({ log: m => logs.push(m), isTTY: false, env: {} });
    for (const signerType of ['local', 'privy', 'walletconnect']) {
      const variant = JSON.parse(fs.readFileSync(quotePath, 'utf8'));
      variant.signerType = signerType;
      fs.writeFileSync(quotePath, JSON.stringify(variant, null, 2));
      await expect(cmds.execute([], api, { 'dry-run': true }, { quote: quoteId }))
        .rejects.toMatchObject({ code: 'ALL_QUOTES_FAILED' });
    }

    expect(logs.join('\n')).not.toContain('DRY RUN — nothing was broadcast');
    expect(executeBodies).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(quotePath, 'utf8')).executedAt).toBeUndefined();
  });

  it('--dry-run applies request-intent validation to Solana quotes before signer resolution', async () => {
    const walletAddress = 'Wallet1111111111111111111111111111111111';
    const quoteId = saveQuote({
      success: true,
      quotes: [{
        aggregator: 'jupiter',
        inputMint: 'So11111111111111111111111111111111111111112',
        outputMint: 'synthetic-output-mint-for-dry-run-test',
        inAmount: '2000000000',
        inputAmount: '2000000000',
        outAmount: '50000000',
        transaction: 'not-needed-before-intent-rejection',
      }],
    }, 'solana', 'privy', { solana: 'server-wallet-id' }, null, {
      swapMode: 'exactIn',
      slippage: 0.03,
      request: {
        chain: 'solana',
        toChain: null,
        walletAddress,
        recipient: null,
        fromToken: 'So11111111111111111111111111111111111111112',
        toToken: 'synthetic-output-mint-for-dry-run-test',
        swapMode: 'exactIn',
        amount: '1000000000',
        maxInputAmount: '1000000000',
      },
    });

    const cmds = buildTradingCommands({ log: () => {}, isTTY: false, env: {} });
    await expect(cmds.execute([], api, { 'dry-run': true }, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'ALL_QUOTES_FAILED' });
  });

  it('--dry-run plans the ERC-20 approval and defers the simulation to the real run', async () => {
    stubFetch({ allowance: 0n });
    const quoteId = erc20Quote('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');

    const logs = [];
    const cmds = buildTradingCommands({ log: m => logs.push(m), promptFn: vi.fn(), isTTY: false, env: {} });
    await cmds.execute([], api, { 'dry-run': true }, { quote: quoteId });

    const out = logs.join('\n');
    expect(out).toContain(`required → ${LIFI_ROUTER}`);
    expect(out).toContain('current allowance is 0');
    expect(out).toContain('runs after the approval transaction lands');
    expect(executeBodies).toHaveLength(0);
  });

  it('interactive confirmation probes and displays the current ERC-20 allowance', async () => {
    stubFetch({ allowance: 0n });
    const quoteId = erc20Quote('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    const logs = [];
    const cmds = buildTradingCommands({
      log: message => logs.push(message),
      promptFn: async () => 'n',
      isTTY: true,
      env: {},
    });

    await expect(cmds.execute([], api, {}, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_DECLINED' });

    const output = logs.join('\n');
    expect(output).toContain(`required → ${LIFI_ROUTER}`);
    expect(output).toContain('current allowance is 0');
    expect(output).toContain('runs after the approval transaction lands');
    expect(executeBodies).toHaveLength(0);
  });

  it('--dry-run reports a sufficient allowance and the simulation result', async () => {
    stubFetch({ allowance: 10n ** 12n });
    const quoteId = erc20Quote('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');

    const logs = [];
    const cmds = buildTradingCommands({ log: m => logs.push(m), promptFn: vi.fn(), isTTY: false, env: {} });
    await cmds.execute([], api, { 'dry-run': true }, { quote: quoteId });

    const out = logs.join('\n');
    expect(out).toContain('no approval transaction needed');
    expect(out).toContain('Simulation:');
    expect(out).toContain('passed');
  });

  it('aborts with exit code 1 and no broadcast when an interactive user declines', async () => {
    stubFetch();
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const quoteId = nativeQuote(showWallet('default').evm);

    const logs = [];
    const promptFn = vi.fn(async () => 'n');
    const cmds = buildTradingCommands({ log: m => logs.push(m), promptFn, isTTY: true, env: {} });

    await expect(cmds.execute([], api, {}, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_DECLINED' });

    expect(promptFn).toHaveBeenCalledWith('Broadcast this transaction? [y/N] ');
    expect(logs.join('\n')).toContain('Trade plan — Base');
    expect(executeBodies).toHaveLength(0);
  });

  it('shows every quote that fallback execution may broadcast', async () => {
    stubFetch();
    const quoteId = nativeQuote('0x742d35Cc6bF3f4e0e3a8DD7e37ff4e4Be4E4B4');
    const quotePath = path.join(tmpHome, '.nansen', 'quotes', `${quoteId}.json`);
    const saved = JSON.parse(fs.readFileSync(quotePath, 'utf8'));
    saved.response.quotes.push({
      ...saved.response.quotes[0],
      aggregator: 'relay',
      outAmount: '2990000000',
    });
    fs.writeFileSync(quotePath, JSON.stringify(saved, null, 2));

    const logs = [];
    const cmds = buildTradingCommands({
      log: message => logs.push(message),
      promptFn: async () => 'n',
      isTTY: true,
      env: {},
    });
    await expect(cmds.execute([], api, {}, { quote: quoteId }))
      .rejects.toMatchObject({ code: 'CONFIRMATION_DECLINED' });

    const output = logs.join('\n');
    expect(output).toContain('(quote 1 of 2)');
    expect(output).toContain('(quote 2 of 2)');
    expect(output).toContain('may try these candidates in order');
    expect(executeBodies).toHaveLength(0);
  });

  it('never broadcasts a fallback candidate omitted from the confirmation plan', async () => {
    stubFetch({ allowBroadcast: true });
    const baseFetch = globalThis.fetch;
    let ethCallCount = 0;
    const codeTargets = [];
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (body.method === 'eth_getCode') codeTargets.push(body.params?.[0]);
      if (body.method === 'eth_call' && ++ethCallCount === 1) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            jsonrpc: '2.0',
            id: body.id || 1,
            error: { message: 'execution reverted: transient preflight failure' },
          }),
        };
      }
      return baseFetch(url, opts);
    }));
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const walletAddress = showWallet('default').evm;
    const quoteId = nativeQuote(walletAddress);
    const quotePath = path.join(tmpHome, '.nansen', 'quotes', `${quoteId}.json`);
    const saved = JSON.parse(fs.readFileSync(quotePath, 'utf8'));
    const consentedTarget = '0x' + 'cd'.repeat(20);
    saved.response.quotes.push({
      ...saved.response.quotes[0],
      aggregator: 'relay',
      transaction: {
        ...saved.response.quotes[0].transaction,
        to: consentedTarget,
        data: '0x87654321',
      },
    });
    fs.writeFileSync(quotePath, JSON.stringify(saved, null, 2));

    const logs = [];
    const cmds = buildTradingCommands({
      log: message => logs.push(message),
      promptFn: async () => 'yes',
      isTTY: true,
      env: {},
    });
    await cmds.execute([], api, { 'no-verify-outcome': true }, { quote: quoteId });

    expect(logs.join('\n')).not.toContain('(quote 1 of 2)');
    expect(logs.join('\n')).toContain('(quote 2 of 2)');
    expect(codeTargets.at(-1)).toBe(consentedTarget);
    expect(executeBodies).toHaveLength(1);
  });

  it('broadcasts after an interactive "y"', async () => {
    stubFetch({ allowBroadcast: true });
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const quoteId = nativeQuote(showWallet('default').evm);

    const promptFn = vi.fn(async () => 'y');
    const cmds = buildTradingCommands({ log: () => {}, promptFn, isTTY: true, env: {} });
    await cmds.execute([], api, { 'no-simulate': true, 'no-verify-outcome': true }, { quote: quoteId });

    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(executeBodies).toHaveLength(1);
  });

  // Two real `trade execute` runs of the same quote. A has loaded the quote
  // and is waiting at the confirmation prompt while B runs start to finish;
  // A must not then broadcast its stale copy.
  it('refuses a quote another run executed while this one waited at the prompt', async () => {
    stubFetch({ allowBroadcast: true });
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const quoteId = nativeQuote(showWallet('default').evm);
    const flags = { 'no-simulate': true, 'no-verify-outcome': true };

    const runB = buildTradingCommands({ log: () => {}, isTTY: false, env: {} });
    const promptFn = vi.fn(async () => {
      await runB.execute([], api, flags, { quote: quoteId });
      return 'y';
    });
    const runA = buildTradingCommands({ log: () => {}, promptFn, isTTY: true, env: {} });

    await expect(runA.execute([], api, flags, { quote: quoteId }))
      .rejects.toThrow(/already executed/);
    expect(executeBodies).toHaveLength(1);
  });

  // B starts while A holds the claim (A is mid-broadcast).
  it('refuses a second run while the first one holds the quote', async () => {
    stubFetch({ allowBroadcast: true });
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const quoteId = nativeQuote(showWallet('default').evm);
    const flags = { 'no-simulate': true, 'no-verify-outcome': true };

    const runB = buildTradingCommands({ log: () => {}, isTTY: false, env: {} });
    let bResult;
    const innerFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (String(url).endsWith('/execute') && bResult === undefined) {
        bResult = await runB.execute([], api, flags, { quote: quoteId }).then(() => 'ok', err => err);
      }
      return innerFetch(url, opts);
    }));
    const runA = buildTradingCommands({ log: () => {}, isTTY: false, env: {} });
    await runA.execute([], api, flags, { quote: quoteId });

    expect(bResult).toBeInstanceOf(Error);
    expect(bResult.message).toMatch(/claimed by another execution/);
    expect(executeBodies).toHaveLength(1);
    // A broadcast and recorded it: the quote is back under its name, spent.
    expect(fs.existsSync(path.join(tmpHome, '.nansen', 'quotes', `${quoteId}.executing.json`))).toBe(false);
    await expect(runB.execute([], api, flags, { quote: quoteId })).rejects.toThrow(/already executed/);
  });

  it('broadcasts without prompting when --yes is passed on a terminal', async () => {
    stubFetch({ allowBroadcast: true });
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const quoteId = nativeQuote(showWallet('default').evm);

    const promptFn = vi.fn();
    const cmds = buildTradingCommands({ log: () => {}, promptFn, isTTY: true, env: {} });
    await cmds.execute([], api, { yes: true, 'no-simulate': true, 'no-verify-outcome': true }, { quote: quoteId });

    expect(promptFn).not.toHaveBeenCalled();
    expect(executeBodies).toHaveLength(1);
  });

  it('broadcasts unprompted when stdin is not a terminal (agents, CI, pipes)', async () => {
    stubFetch({ allowBroadcast: true });
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const quoteId = nativeQuote(showWallet('default').evm);

    const logs = [];
    const promptFn = vi.fn();
    const cmds = buildTradingCommands({ log: m => logs.push(m), promptFn, isTTY: false, env: {} });
    await cmds.execute([], api, { 'no-simulate': true, 'no-verify-outcome': true }, { quote: quoteId });

    expect(promptFn).not.toHaveBeenCalled();
    expect(executeBodies).toHaveLength(1);
    // Nothing extra on stdout for non-interactive callers: no plan, no prompt.
    expect(logs.join('\n')).not.toContain('Trade plan');
  });

  it('treats NANSEN_YES=1 like --yes on a terminal', async () => {
    stubFetch({ allowBroadcast: true });
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const quoteId = nativeQuote(showWallet('default').evm);

    const promptFn = vi.fn();
    const cmds = buildTradingCommands({
      log: () => {}, promptFn, isTTY: true, env: { NANSEN_YES: '1' },
    });
    await cmds.execute([], api, { 'no-simulate': true, 'no-verify-outcome': true }, { quote: quoteId });

    expect(promptFn).not.toHaveBeenCalled();
    expect(executeBodies).toHaveLength(1);
  });

  it('exits 1 through the CLI when the confirmation is declined', async () => {
    stubFetch();
    createWallet('default', 'testpass');
    process.env.NANSEN_WALLET_PASSWORD = 'testpass';
    const quoteId = nativeQuote(showWallet('default').evm);

    const stdout = [];
    const stderr = [];
    const exit = vi.fn();
    await runCLI(['trade', 'execute', '--quote', quoteId], {
      output: m => stdout.push(m),
      errorOutput: m => stderr.push(m),
      log: m => stdout.push(m),
      exit,
      isTTY: true,
      confirmationPromptFn: async () => 'n',
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.join('\n')).toContain('Aborted at the confirmation prompt');
    expect(stdout.join('\n')).not.toContain('CONFIRMATION_DECLINED');
    expect(stdout.join('\n')).not.toContain('"success": false');
    expect(executeBodies).toHaveLength(0);
  });

  it('uses stdin TTY state when stdout is redirected', async () => {
    stubFetch();
    const quoteId = nativeQuote('0x742d35Cc6bF4F3f4e0e3a8DD7e37ff4e4Be4E4B4');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      const stdout = [];
      const stderr = [];
      const promptFn = vi.fn(async (question) => {
        stderr.push(question);
        return 'n';
      });
      const exit = vi.fn();
      await runCLI(['trade', 'execute', '--quote', quoteId], {
        output: message => stdout.push(message),
        errorOutput: message => stderr.push(message),
        log: message => stdout.push(message),
        exit,
        confirmationPromptFn: promptFn,
      });

      expect(promptFn).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(executeBodies).toHaveLength(0);
      expect(stderr.join('\n')).toContain('Trade plan — Base');
      expect(stderr.join('\n')).toContain('Broadcast this transaction?');
      expect(stdout.join('\n')).not.toContain('Trade plan — Base');
    } finally {
      delete process.stdin.isTTY;
      delete process.stdout.isTTY;
    }
  });

  it('describes a cross-chain swap by route in the plan', async () => {
    const plan = await buildTradeExecutionPlan({
      quoteId: 'q1',
      quoteData: {
        chain: 'base',
        toChain: 'solana',
        request: { fromToken: BASE_USDC, toToken: 'So11111111111111111111111111111111111111112', recipient: 'SoLrecipient' },
      },
      quote: { aggregator: 'relay', inputMint: BASE_USDC, outputMint: 'So11', inAmount: '1000000', outAmount: '5000' },
      chainConfig: { name: 'Base', type: 'evm' },
    });

    expect(plan).toContain('Trade plan — Base → Solana');
    expect(plan).toContain('via relay');
    expect(plan).toContain('SoLrecipient');
  });
});
