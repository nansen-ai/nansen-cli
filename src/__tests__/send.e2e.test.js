/**
 * End-to-end send tests — runs the actual CLI against mainnet.
 *
 * Prerequisites:
 *   - Two wallets in ~/.nansen/wallets/ with ETH on Base and SOL on Solana
 *   - NANSEN_WALLET_PASSWORD env var set
 *
 * Run: npm run test:send (or: npx vitest run --config vitest.e2e.config.js src/__tests__/send.e2e.test.js)
 *
 * These tests execute REAL transfers with REAL funds. They are excluded
 * from the default test suite and must be run explicitly.
 *
 * Each test sends a tiny amount from wallet A → B, then back B → A,
 * so the net cost is just gas fees.
 */

import { spawnSync } from "child_process";
import { describe, it, expect, beforeAll } from "vitest";
import path from "path";

const CLI_PATH = path.resolve("src/index.js");

function runCli(...args) {
  const { stdout, stderr, status } = spawnSync("node", [CLI_PATH, ...args], {
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { stdout: stdout || "", stderr: stderr || "", exitCode: status ?? 1 };
}

/**
 * Parse `wallet list` output to extract wallet names and addresses.
 * Returns array of { name, evm, solana }.
 */
function parseWalletList(output) {
  const wallets = [];
  const lines = output.split("\n");
  let current = null;
  for (const line of lines) {
    const nameMatch = line.match(/^\s*(\S+)\s*★?\s*$/);
    if (nameMatch) {
      current = { name: nameMatch[1] };
      wallets.push(current);
      continue;
    }
    if (!current) continue;
    const evmMatch = line.match(/EVM:\s+(0x[a-fA-F0-9]+)/);
    if (evmMatch) current.evm = evmMatch[1];
    const solMatch = line.match(/Solana:\s+([1-9A-HJ-NP-Za-km-z]+)/);
    if (solMatch) current.solana = solMatch[1];
  }
  return wallets;
}

const SEND_AMOUNT_ETH = "0.0001"; // ~$0.20 (must cover return gas + L1 data fees on Base)
const SEND_AMOUNT_SOL = "0.001"; // ~$0.08

let walletA;
let walletB;

beforeAll(() => {
  expect(
    process.env.NANSEN_WALLET_PASSWORD,
    "Set NANSEN_WALLET_PASSWORD to run e2e tests"
  ).toBeDefined();

  const result = runCli("wallet", "list");
  const wallets = parseWalletList(result.stdout + result.stderr);
  if (wallets.length < 2) {
    const hint = wallets.length === 0
      ? "Create two wallets with: nansen wallet create --name test1 && nansen wallet create --name test2"
      : `Found "${wallets[0].name}" only. Create another with: nansen wallet create --name test2`;
    throw new Error(`Need at least 2 wallets for send e2e tests. ${hint}`);
  }
  walletA = wallets[0];
  walletB = wallets[1];
});

describe.sequential("e2e: native ETH send round-trip on Base", () => {
  it("send ETH: A → B", () => {
    const result = runCli(
      "wallet", "send",
      "--to", walletB.evm,
      "--amount", SEND_AMOUNT_ETH,
      "--chain", "base",
      "--wallet", walletA.name,
    );
    const output = result.stdout + result.stderr;

    expect(result.exitCode, `CLI failed:\n${output}`).toBe(0);
    expect(output).toContain("Transaction sent");

    const txMatch = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
    expect(txMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    console.log(`ETH A→B: https://basescan.org/tx/${txMatch[1]}`);
  });

  it("send ETH: B → A (--max)", () => {
    const result = runCli(
      "wallet", "send",
      "--to", walletA.evm,
      "--max",
      "--chain", "base",
      "--wallet", walletB.name,
    );
    const output = result.stdout + result.stderr;

    expect(result.exitCode, `CLI failed:\n${output}`).toBe(0);
    expect(output).toContain("Transaction sent");

    const txMatch = output.match(/Tx Hash:\s+(0x[a-fA-F0-9]+)/);
    expect(txMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    console.log(`ETH B→A: https://basescan.org/tx/${txMatch[1]}`);
  });
});

describe.sequential("e2e: native SOL send round-trip on Solana", () => {
  it("send SOL: A → B", () => {
    const result = runCli(
      "wallet", "send",
      "--to", walletB.solana,
      "--amount", SEND_AMOUNT_SOL,
      "--chain", "solana",
      "--wallet", walletA.name,
    );
    const output = result.stdout + result.stderr;

    expect(result.exitCode, `CLI failed:\n${output}`).toBe(0);
    expect(output).toContain("Transaction sent");

    const sigMatch = output.match(/Tx Hash:\s+([1-9A-HJ-NP-Za-km-z]{43,})/);
    expect(sigMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    console.log(`SOL A→B: https://solscan.io/tx/${sigMatch[1]}`);
  });

  it("send SOL: B → A (--max)", () => {
    const result = runCli(
      "wallet", "send",
      "--to", walletA.solana,
      "--max",
      "--chain", "solana",
      "--wallet", walletB.name,
    );
    const output = result.stdout + result.stderr;

    expect(result.exitCode, `CLI failed:\n${output}`).toBe(0);
    expect(output).toContain("Transaction sent");

    const sigMatch = output.match(/Tx Hash:\s+([1-9A-HJ-NP-Za-km-z]{43,})/);
    expect(sigMatch, `Expected Tx Hash in output:\n${output}`).toBeTruthy();
    console.log(`SOL B→A: https://solscan.io/tx/${sigMatch[1]}`);
  });
});
