/**
 * MCP Server — exposes all Nansen research commands as MCP tools (stdio transport).
 *
 * Usage:  nansen mcp
 * Reads NANSEN_API_KEY from env (same as CLI).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SCHEMA, buildCommands } from './cli.js';
import { NansenAPI } from './api.js';

// ---------------------------------------------------------------------------
// Schema helpers — convert Nansen option definitions to JSON Schema properties
// ---------------------------------------------------------------------------

/** Map a single Nansen option type string to a JSON Schema type (or types). */
function jsonSchemaType(nansenType) {
  if (!nansenType) return 'string';
  if (nansenType === 'number') return 'number';
  if (nansenType === 'boolean') return 'boolean';
  if (nansenType === 'array') return 'array';
  if (nansenType === 'object') return 'object';
  if (nansenType === 'string|array') return ['string', 'array'];
  return 'string';
}

/** Convert a Nansen options block to a JSON Schema `properties` + `required` pair. */
function optionsToJsonSchema(options) {
  if (!options) return { type: 'object', properties: {} };

  const properties = {};
  const required = [];

  for (const [name, opt] of Object.entries(options)) {
    const prop = { type: jsonSchemaType(opt.type) };
    if (opt.description) prop.description = opt.description;
    if (opt.default !== undefined) prop.default = opt.default;
    if (opt.enum) prop.enum = opt.enum;
    if (Array.isArray(prop.type) && prop.type.includes('array')) {
      // For string|array, items are strings
      prop.items = { type: 'string' };
    } else if (prop.type === 'array') {
      prop.items = { type: 'string' };
    }
    properties[name] = prop;
    if (opt.required) required.push(name);
  }

  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

// ---------------------------------------------------------------------------
// Walk the research schema tree and collect tool definitions
// ---------------------------------------------------------------------------

/**
 * Returns an array of { name, description, inputSchema, category, subcommand }.
 * Tool names use underscores: smart_money_netflow, token_screener, search, etc.
 */
export function buildToolDefinitions() {
  const tools = [];
  const research = SCHEMA.commands?.research?.subcommands;
  if (!research) return tools;

  for (const [categoryKey, categoryDef] of Object.entries(research)) {
    // Some categories are leaf commands (e.g. "search") without subcommands
    if (categoryDef.options && !categoryDef.subcommands) {
      const toolName = categoryKey.replace(/-/g, '_');
      tools.push({
        name: toolName,
        description: categoryDef.description || categoryKey,
        inputSchema: optionsToJsonSchema(categoryDef.options),
        category: categoryKey,
        subcommand: null,
      });
      continue;
    }

    if (!categoryDef.subcommands) continue;

    for (const [subKey, subDef] of Object.entries(categoryDef.subcommands)) {
      const toolName = `${categoryKey.replace(/-/g, '_')}_${subKey.replace(/-/g, '_')}`;
      tools.push({
        name: toolName,
        description: subDef.description || `${categoryKey} ${subKey}`,
        inputSchema: optionsToJsonSchema(subDef.options),
        category: categoryKey,
        subcommand: subKey,
      });
    }
  }

  return tools;
}

// ---------------------------------------------------------------------------
// Start MCP server
// ---------------------------------------------------------------------------

export async function startMcpServer() {
  const toolDefs = buildToolDefinitions();

  // Build a lookup map: toolName → { category, subcommand }
  const toolMap = new Map();
  for (const t of toolDefs) {
    toolMap.set(t.name, t);
  }

  // Build CLI command handlers (no interactive prompts, no console.log in core)
  const noop = () => {};
  const commands = buildCommands({
    log: noop,
    errorOutput: noop,
    exit: noop,
  });

  const server = new Server(
    { name: 'nansen', version: SCHEMA.version || '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // -- tools/list --------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefs.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // -- tools/call ---------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const toolDef = toolMap.get(name);
    if (!toolDef) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    const { category, subcommand } = toolDef;

    // Build the flags and options objects that CLI handlers expect
    const flags = {};
    const options = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'boolean') {
        flags[key] = value;
      } else {
        options[key] = value;
      }
    }

    // Build positional args: the handler for category receives [subcommand, ...]
    const positional = subcommand ? [subcommand] : [];

    // For 'search', the first positional arg can be the query
    if (category === 'search' && options.query && !subcommand) {
      positional.push(options.query);
    }

    try {
      const api = new NansenAPI();
      const handler = commands[category];
      if (!handler) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `No handler for category: ${category}` }) }],
          isError: true,
        };
      }

      const result = await handler(positional, api, flags, options);
      const text = JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const errorPayload = {
        error: err.message || String(err),
        ...(err.code && { code: err.code }),
        ...(err.status && { status: err.status }),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
        isError: true,
      };
    }
  });

  // -- connect & run -------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Nansen MCP server running on stdio\n');
}
