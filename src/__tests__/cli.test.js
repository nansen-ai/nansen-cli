/**
 * CLI Smoke Tests
 * 
 * Minimal end-to-end tests that verify the CLI binary works.
 * Detailed logic tests are in cli.internal.test.js (with coverage).
 * 
 * These tests spawn subprocesses so they're slower and don't contribute
 * to coverage metrics, but they verify the real CLI works.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'index.js');

// Helper to run CLI commands
function runCLI(args, options = {}) {
  const env = {
    ...process.env,
    NANSEN_API_KEY: 'test-key',
    ...options.env
  };
  
  try {
    const result = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf8',
      env,
      timeout: 10000
    });
    return { stdout: result, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.status
    };
  }
}

describe('CLI Smoke Tests', () => {
  // =================== Help & Basic Commands ===================

  it('should show help', () => {
    const { stdout, exitCode } = runCLI('help');
    
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Nansen CLI');
    expect(stdout).toContain('smart-money');
    expect(stdout).toContain('profiler');
    expect(stdout).toContain('token');
  });

  it('should show schema', () => {
    const { stdout, exitCode } = runCLI('schema');
    
    expect(exitCode).toBe(0);
    const schema = JSON.parse(stdout);
    expect(schema.version).toBeDefined();
    expect(schema.commands).toBeDefined();
  });

  // =================== JSON Output Format ===================

  it('should output valid JSON on error', () => {
    const { stdout, stderr, exitCode } = runCLI('smart-money netflow', {
      env: { NANSEN_API_KEY: 'invalid-key' }
    });

    // Should fail with auth error but still output valid JSON (error goes to stderr)
    // Parse first JSON line only (stderr may contain update notifications)
    const output = stdout || stderr;
    const firstLine = output.split('\n').find(l => l.startsWith('{'));
    const result = JSON.parse(firstLine);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.code).toBeDefined();
  });

  it('should support --pretty flag', () => {
    const { stdout, exitCode } = runCLI('schema --pretty');
    
    expect(exitCode).toBe(0);
    expect(stdout).toContain('\n'); // Pretty JSON has newlines
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  // =================== Command Routing ===================

  it('should route smart-money commands', () => {
    const { stdout } = runCLI('smart-money help');
    expect(stdout).toContain('netflow');
  });

  it('should route profiler commands', () => {
    const { stdout } = runCLI('profiler help');
    expect(stdout).toContain('balance');
  });

  it('should route token commands', () => {
    const { stdout } = runCLI('token help');
    expect(stdout).toContain('screener');
  });

  // =================== Environment Variables ===================

  it('should use NANSEN_API_KEY from environment', () => {
    const { stdout, stderr } = runCLI('smart-money netflow', {
      env: { NANSEN_API_KEY: 'test-env-key' }
    });
    
    // Will fail auth but proves env var is being read (error goes to stderr)
    // Parse first JSON line only (stderr may contain update notifications)
    const output = stdout || stderr;
    const firstLine = output.split('\n').find(l => l.startsWith('{'));
    const result = JSON.parse(firstLine);
    expect(result.success).toBe(false);
    expect(['UNAUTHORIZED', 'PAYMENT_REQUIRED', 'UNKNOWN']).toContain(result.code);
  });

  // =================== Error Handling ===================

  it('should handle unknown command gracefully', () => {
    const { stdout, exitCode } = runCLI('unknown-command');
    
    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.error).toContain('Unknown command');
  });

  it('should handle unknown subcommand gracefully', () => {
    const { stdout } = runCLI('smart-money unknown-subcommand');
    
    const result = JSON.parse(stdout);
    expect(result.data.error).toContain('Unknown subcommand');
  });

  // =================== Prediction Market Commands ===================

  it('should show prediction help', () => {
    const { stdout, exitCode } = runCLI('prediction help');

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.data.commands).toContain('markets');
    expect(result.data.commands).toContain('trades');
    expect(result.data.commands).toContain('leaderboard');
  });

  it('should show prediction in schema', () => {
    const { stdout, exitCode } = runCLI('schema prediction');

    expect(exitCode).toBe(0);
    const firstLine = stdout.split('\n').find(l => l.startsWith('{'));
    const result = JSON.parse(firstLine);
    expect(result.command).toBe('prediction');
    expect(result.subcommands).toHaveProperty('markets');
    expect(result.subcommands).toHaveProperty('trades');
    expect(result.subcommands).toHaveProperty('market-detail');
    expect(result.subcommands).toHaveProperty('top-holders');
    expect(result.subcommands).toHaveProperty('leaderboard');
    expect(result.subcommands).toHaveProperty('events');
  });

  it('should require market ID for prediction market-detail', () => {
    const { stdout, exitCode } = runCLI('prediction market-detail');

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.data.error).toContain('Market ID or slug required');
  });

  it('should require market ID for prediction trades', () => {
    const { stdout, exitCode } = runCLI('prediction trades');

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.data.error).toContain('Market ID or slug required');
  });

  it('should require market ID for prediction top-holders', () => {
    const { stdout, exitCode } = runCLI('prediction top-holders');

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.data.error).toContain('Market ID or slug required');
  });

  it('should handle unknown prediction subcommand', () => {
    const { stdout, exitCode } = runCLI('prediction unknown-sub');

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.data.error).toContain('Unknown subcommand');
  });

  it('should support prediction alias "pred"', () => {
    const { stdout, exitCode } = runCLI('pred help');

    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.data.commands).toContain('markets');
  });

  it('should handle prediction leaderboard command', () => {
    const { stdout, stderr } = runCLI('prediction leaderboard', {
      env: { NANSEN_API_KEY: 'test-key' }
    });
    
    // Will fail auth but proves command routing works
    const output = stdout || stderr;
    const firstLine = output.split('\n').find(l => l.startsWith('{'));
    const result = JSON.parse(firstLine);
    expect(result.success).toBe(false);
    expect(['UNAUTHORIZED', 'PAYMENT_REQUIRED', 'UNKNOWN']).toContain(result.code);
  });

  it('should handle prediction markets command', () => {
    const { stdout, stderr } = runCLI('prediction markets', {
      env: { NANSEN_API_KEY: 'test-key' }
    });
    
    // Will fail auth but proves command routing works
    const output = stdout || stderr;
    const firstLine = output.split('\n').find(l => l.startsWith('{'));
    const result = JSON.parse(firstLine);
    expect(result.success).toBe(false);
    expect(['UNAUTHORIZED', 'PAYMENT_REQUIRED', 'UNKNOWN']).toContain(result.code);
  });
});
