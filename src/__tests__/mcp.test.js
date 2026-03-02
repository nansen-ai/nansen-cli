/**
 * MCP Server Tests — schema registration and tool definitions only.
 * Does not start a live MCP server.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildToolDefinitions } from '../mcp.js';
import { buildCommands, SCHEMA } from '../cli.js';

describe('MCP tool definitions', () => {
  it('should generate tool definitions from schema', () => {
    const tools = buildToolDefinitions();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('should use underscored names for tools', () => {
    const tools = buildToolDefinitions();
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z0-9_]+$/);
      expect(tool.name).not.toContain('-');
    }
  });

  it('should include smart_money_netflow', () => {
    const tools = buildToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain('smart_money_netflow');
  });

  it('should include token_screener', () => {
    const tools = buildToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain('token_screener');
  });

  it('should include profiler_balance', () => {
    const tools = buildToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain('profiler_balance');
  });

  it('should include search as a top-level tool', () => {
    const tools = buildToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain('search');
  });

  it('should include perp_screener and perp_leaderboard', () => {
    const tools = buildToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain('perp_screener');
    expect(names).toContain('perp_leaderboard');
  });

  it('should include points_leaderboard', () => {
    const tools = buildToolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain('points_leaderboard');
  });

  it('should NOT include wallet or trade tools', () => {
    const tools = buildToolDefinitions();
    const names = tools.map((t) => t.name);
    const hasWallet = names.some((n) => n.startsWith('wallet'));
    const hasTrade = names.some((n) => n === 'quote' || n === 'execute' || n.startsWith('trade'));
    expect(hasWallet).toBe(false);
    expect(hasTrade).toBe(false);
  });

  it('should have valid inputSchema for each tool', () => {
    const tools = buildToolDefinitions();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('should mark required options in inputSchema', () => {
    const tools = buildToolDefinitions();
    const profilerBalance = tools.find((t) => t.name === 'profiler_balance');
    expect(profilerBalance).toBeDefined();
    expect(profilerBalance.inputSchema.required).toContain('address');
  });

  it('should include enum values in inputSchema', () => {
    const tools = buildToolDefinitions();
    const tokenOhlcv = tools.find((t) => t.name === 'token_ohlcv');
    expect(tokenOhlcv).toBeDefined();
    const tf = tokenOhlcv.inputSchema.properties.timeframe;
    expect(tf.enum).toBeDefined();
    expect(tf.enum).toContain('1h');
  });

  it('should have descriptions for tools', () => {
    const tools = buildToolDefinitions();
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe('MCP command registration', () => {
  it('should register mcp command in buildCommands', () => {
    const commands = buildCommands({
      log: () => {},
      errorOutput: () => {},
      exit: () => {},
    });
    expect(commands).toHaveProperty('mcp');
    expect(typeof commands.mcp).toBe('function');
  });

  it('should include mcp in schema.json commands', () => {
    expect(SCHEMA.commands).toHaveProperty('mcp');
    expect(SCHEMA.commands.mcp.description).toMatch(/MCP/i);
  });
});
