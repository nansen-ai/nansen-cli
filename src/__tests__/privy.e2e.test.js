/**
 * E2E tests for Privy wallet creation — runs the actual CLI.
 *
 * Prerequisites:
 *   - PRIVY_APP_ID and PRIVY_APP_SECRET env vars set
 *
 * Run: npx vitest run --config vitest.e2e.config.js src/__tests__/privy.e2e.test.js
 *
 * These tests create REAL Privy server wallets. They are excluded
 * from the default test suite and must be run explicitly.
 * Created wallets are cleaned up via the Privy API in afterAll.
 */

import { spawnSync } from "child_process";
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const CLI_PATH = path.resolve("src/index.js");
const HAS_CREDENTIALS = !!(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);

// Isolated HOME dir so we don't touch the real wallet store
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nansen-privy-e2e-"));

function runCli(...args) {
  const { stdout, stderr, status } = spawnSync("node", [CLI_PATH, ...args], {
    env: { ...process.env, HOME: tempDir },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { stdout: stdout || "", stderr: stderr || "", exitCode: status ?? 1 };
}

/**
 * Read a wallet reference file from the isolated HOME dir.
 */
function readWalletFile(name) {
  const walletFile = path.join(tempDir, ".nansen", "wallets", `${name}.json`);
  return JSON.parse(fs.readFileSync(walletFile, "utf8"));
}

/**
 * Delete a Privy wallet by ID via the API (for cleanup).
 */
async function deletePrivyWallet(walletId) {
  const auth = Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString("base64");
  await fetch(`https://api.privy.io/v1/wallets/${walletId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Basic ${auth}`,
      "privy-app-id": process.env.PRIVY_APP_ID,
      "Content-Type": "application/json",
    },
  });
}

// Track Privy wallet IDs for cleanup
const createdPrivyIds = [];

afterAll(async () => {
  await Promise.allSettled(createdPrivyIds.map((id) => deletePrivyWallet(id)));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe.skipIf(!HAS_CREDENTIALS).sequential("e2e: Privy wallet", () => {
  it("creates EVM + Solana wallets", () => {
    const result = runCli("wallet", "create", "--provider", "privy", "--name", "e2e-test");
    const output = result.stdout + result.stderr;

    expect(output).toContain('Privy wallet "e2e-test" created');
    expect(output).toMatch(/EVM:\s+0x[0-9a-fA-F]{40}/);
    expect(output).toMatch(/Solana:\s+[1-9A-HJ-NP-Za-km-z]+/);
    expect(result.exitCode).toBe(0);

    // Track for cleanup
    const data = readWalletFile("e2e-test");
    createdPrivyIds.push(data.evm.privyWalletId, data.solana.privyWalletId);
  });

  it("stores correct local reference file", () => {
    const data = readWalletFile("e2e-test");

    expect(data.provider).toBe("privy");
    expect(data.name).toBe("e2e-test");
    expect(data.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(data.evm.privyWalletId).toBeTruthy();
    expect(data.solana.address).toBeTruthy();
    expect(data.solana.privyWalletId).toBeTruthy();
    expect(data.createdAt).toBeTruthy();
  });

  it("sets as default wallet", () => {
    const result = runCli("wallet", "list");
    const output = result.stdout + result.stderr;

    expect(output).toContain("e2e-test");
    expect(output).toMatch(/e2e-test\s*★/);
  });

  it("shows wallet details", () => {
    const result = runCli("wallet", "show", "e2e-test");
    const output = result.stdout + result.stderr;

    expect(output).toContain("e2e-test");
    expect(output).toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("rejects duplicate wallet names", () => {
    const result = runCli("wallet", "create", "--provider", "privy", "--name", "e2e-test");
    const output = result.stdout + result.stderr;

    expect(output).toContain("already exists");
    expect(result.exitCode).toBe(1);
  });

  it("creates a second wallet without changing default", () => {
    const result = runCli("wallet", "create", "--provider", "privy", "--name", "e2e-second");
    const output = result.stdout + result.stderr;

    expect(output).toContain('Privy wallet "e2e-second" created');
    expect(result.exitCode).toBe(0);

    const data = readWalletFile("e2e-second");
    createdPrivyIds.push(data.evm.privyWalletId, data.solana.privyWalletId);

    // Default should still be e2e-test
    const list = runCli("wallet", "list");
    expect(list.stdout + list.stderr).toMatch(/e2e-test\s*★/);
  });

  it("deletes wallet and updates default", () => {
    const result = runCli("wallet", "delete", "e2e-test");
    const output = result.stdout + result.stderr;

    expect(output).toContain('Wallet "e2e-test" deleted');
    expect(output).toContain("Privy");
    expect(result.exitCode).toBe(0);

    // Default should switch to e2e-second
    const list = runCli("wallet", "list");
    expect(list.stdout + list.stderr).toMatch(/e2e-second\s*★/);
  });

  it("rejects export for Privy wallets", () => {
    const result = runCli("wallet", "export", "e2e-second");
    const output = result.stdout + result.stderr;

    expect(output).toMatch(/privy|provider/i);
    expect(result.exitCode).toBe(1);
  });
});
