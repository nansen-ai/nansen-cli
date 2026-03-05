#!/usr/bin/env node

/**
 * Sync schema.json from the Nansen OpenAPI spec.
 *
 * Usage:
 *   node scripts/sync-schema.js          # Preview diff
 *   node scripts/sync-schema.js --apply  # Apply changes
 *   node scripts/sync-schema.js --help   # Show help
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "..", "src", "schema.json");
const OVERRIDES_PATH = path.join(__dirname, "schema-overrides.json");
const OPENAPI_URL = "https://api.nansen.ai/openapi.json";

let componentsSchemas = {};

async function fetchOpenAPISpec() {
  console.error("[sync-schema] Fetching OpenAPI spec...");
  const res = await fetch(OPENAPI_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`);
  }
  const spec = await res.json();
  componentsSchemas = spec.components?.schemas || {};
  return spec;
}

function loadOverrides() {
  return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8"));
}

function loadCurrentSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
}

/**
 * Resolve a $ref to its actual schema
 */
function resolveRef(ref) {
  if (!ref) return null;
  const match = ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!match) return null;
  return componentsSchemas[match[1]];
}

/**
 * Recursively resolve a schema, handling $ref, anyOf, allOf
 */
function resolveSchema(schema) {
  if (!schema) return null;

  if (schema.$ref) {
    return resolveSchema(resolveRef(schema.$ref));
  }

  if (schema.anyOf) {
    // Return first non-null option (typically the actual type)
    for (const option of schema.anyOf) {
      const resolved = resolveSchema(option);
      if (resolved && resolved.type !== "null") {
        return resolved;
      }
    }
    return resolveSchema(schema.anyOf[0]);
  }

  if (schema.allOf) {
    // Merge all schemas
    const merged = { properties: {}, required: [] };
    for (const sub of schema.allOf) {
      const resolved = resolveSchema(sub);
      if (resolved?.properties) {
        Object.assign(merged.properties, resolved.properties);
      }
      if (resolved?.required) {
        merged.required.push(...resolved.required);
      }
    }
    return { ...schema, ...merged };
  }

  return schema;
}

/**
 * Extract parameter info from OpenAPI request body schema
 */
function extractParams(requestBody) {
  if (!requestBody?.content?.["application/json"]?.schema) {
    return {};
  }

  const rawSchema = requestBody.content["application/json"].schema;
  const schema = resolveSchema(rawSchema);
  if (!schema) return {};

  const properties = schema.properties || {};
  const required = schema.required || [];
  const params = {};

  for (const [name, rawProp] of Object.entries(properties)) {
    const prop = resolveSchema(rawProp) || rawProp;

    // Skip complex nested objects that we handle specially
    if (name === "pagination") {
      // Extract pagination fields directly
      const paginationSchema = resolveSchema(prop);
      if (paginationSchema?.properties) {
        for (const [pName, pProp] of Object.entries(paginationSchema.properties)) {
          const resolvedPProp = resolveSchema(pProp) || pProp;
          const cliName = pName === "per_page" ? "limit" : pName;
          params[cliName] = {
            type: mapType(resolvedPProp.type, resolvedPProp),
          };
        }
      }
      continue;
    }

    if (name === "order_by") {
      // Simplify order_by to a sort string
      params.sort = { type: "string" };
      continue;
    }

    if (name === "filters") {
      // Simplify filters to a JSON object
      params.filters = { type: "object" };
      continue;
    }

    const param = { type: mapType(prop.type, prop) };

    // Lean schema: skip descriptions and enums, keep type/required/default
    if (required.includes(name)) {
      param.required = true;
    }

    if (prop.default !== undefined) {
      param.default = prop.default;
    }

    params[name] = param;
  }

  return params;
}

/**
 * Map OpenAPI types to CLI schema types
 */
function mapType(type, prop) {
  if (type === "integer") return "number";
  if (type === "array") return "array";
  if (type === "object") return "object";
  if (type === "boolean") return "boolean";
  if (prop?.oneOf) {
    const types = prop.oneOf.map((o) => o.type).filter(Boolean);
    if (types.length > 1) return types.join("|");
  }
  return "string";
}

/**
 * Extract top-level return field names from response schema
 */
function extractReturns(responses) {
  const successResponse = responses?.["200"] || responses?.["201"];
  if (!successResponse?.content?.["application/json"]?.schema) {
    return [];
  }

  const rawSchema = successResponse.content["application/json"].schema;
  const schema = resolveSchema(rawSchema);
  return extractFieldNames(schema);
}

/**
 * Recursively extract field names, flattening to top-level
 */
function extractFieldNames(schema, prefix = "", depth = 0) {
  if (depth > 2) return []; // Limit nesting depth
  if (!schema) return [];

  const fields = [];

  // Handle $ref
  if (schema.$ref) {
    return extractFieldNames(resolveRef(schema.$ref), prefix, depth);
  }

  // Handle data wrapper pattern
  if (schema.properties?.data) {
    const dataSchema = resolveSchema(schema.properties.data);
    return extractFieldNames(dataSchema, "", 0);
  }

  // Handle array items
  if (schema.type === "array" && schema.items) {
    const itemSchema = resolveSchema(schema.items);
    return extractFieldNames(itemSchema, prefix, depth);
  }

  // Handle allOf
  if (schema.allOf) {
    for (const subSchema of schema.allOf) {
      const resolved = resolveSchema(subSchema);
      fields.push(...extractFieldNames(resolved, prefix, depth));
    }
    return [...new Set(fields)];
  }

  // Handle anyOf (pick first valid option)
  if (schema.anyOf) {
    const resolved = resolveSchema(schema);
    return extractFieldNames(resolved, prefix, depth);
  }

  // Handle properties
  if (schema.properties) {
    for (const [name, rawProp] of Object.entries(schema.properties)) {
      // Skip pagination/meta fields
      if (["pagination", "success", "message"].includes(name)) continue;

      const prop = resolveSchema(rawProp) || rawProp;

      if (prop.type === "object" && prop.properties && depth < 1) {
        // For nested objects, include field with nested names
        const nested = Object.keys(prop.properties).slice(0, 5);
        if (nested.length > 0) {
          fields.push(`${name}[${nested.join(", ")}]`);
        } else {
          fields.push(name);
        }
      } else if (prop.type === "array" && depth < 1) {
        const itemSchema = resolveSchema(prop.items);
        if (itemSchema?.properties) {
          const nested = Object.keys(itemSchema.properties).slice(0, 5);
          if (nested.length > 0) {
            fields.push(`${name}[${nested.join(", ")}]`);
          } else {
            fields.push(name);
          }
        } else {
          fields.push(name);
        }
      } else {
        fields.push(name);
      }
    }
  }

  return fields;
}

/**
 * Convert API path to CLI command path
 */
function apiPathToCommandPath(apiPath, overrides) {
  // Check explicit mappings first
  if (overrides.apiPathMappings?.[apiPath]) {
    return overrides.apiPathMappings[apiPath];
  }
  if (overrides.apiPathMappings?.[apiPath] === null) {
    return null; // Explicitly excluded
  }

  // Auto-map based on path structure
  const parts = apiPath
    .replace("/api/v1/", "")
    .replace("/address/", "/")
    .split("/");

  if (parts[0] === "tgm") {
    parts[0] = "token";
  }

  return `research.${parts.join(".")}`;
}

/**
 * Standard parameter name mappings
 */
const PARAM_RENAMES = {
  wallet_address: "wallet",
  token_address: "token",
  per_page: "limit",
  recordsPerPage: "limit",
};


/**
 * Apply overrides to extracted params
 */
function applyOverrides(commandPath, params, overrides) {
  const shortPath = commandPath.replace("research.", "").replace(/\./g, "/");
  const defaults = overrides.defaults?.[shortPath] || {};
  const globalDrops = overrides.drop?.global || [];
  const commandDrops = overrides.drop?.[shortPath] || [];
  const drops = [...globalDrops, ...commandDrops];
  const enums = overrides.enums?.[shortPath] || {};
  const customRename = overrides.rename || {};

  const result = {};

  // If 'chains' is present and required, add a singular 'chain' option with default
  const hasChains = params.chains && params.chains.required;

  for (const [name, param] of Object.entries(params)) {
    // Skip dropped fields
    if (drops.includes(name)) continue;

    // Apply standard renames, then custom renames
    let newName = PARAM_RENAMES[name] || name;
    if (customRename[name] !== undefined) {
      if (customRename[name] === null) continue; // Drop this field
      newName = customRename[name];
    }

    // Copy param
    const newParam = { ...param };

    // Special handling for chains array - make it optional, add singular chain
    if (name === "chains" && hasChains) {
      delete newParam.required;
    }

    // Apply defaults (removes required if default is set)
    if (defaults[newName] !== undefined) {
      newParam.default = defaults[newName];
      delete newParam.required;
    }

    // Apply enums (only from overrides, not from API spec)
    if (enums[newName]) {
      newParam.enum = enums[newName];
    }

    // Lean schema: remove any descriptions that may have been copied
    delete newParam.description;

    result[newName] = newParam;
  }

  // Add singular 'chain' option if 'chains' exists and has a default
  if (hasChains && defaults.chain !== undefined) {
    result.chain = {
      type: "string",
      default: defaults.chain,
    };
  }

  // Add standard pagination param if not present
  if (!result.page && result.limit) {
    result.page = { type: "number" };
  }

  // Add extra params from overrides (command-specific or category-level)
  // These can override existing params to add required flags, etc.
  const category = shortPath.split("/")[0];
  const commandExtra = overrides.extraParams?.[shortPath] || {};
  const categoryExtra = overrides.extraParams?.[category] || {};

  for (const [name, param] of Object.entries({ ...categoryExtra, ...commandExtra })) {
    // Lean schema: strip descriptions from extraParams too
    const leanParam = { ...param };
    delete leanParam.description;

    // Merge with existing param or add new one
    if (result[name]) {
      result[name] = { ...result[name], ...leanParam };
    } else {
      result[name] = leanParam;
    }
  }

  return result;
}

/**
 * Set value at nested path in object
 */
function setNestedValue(obj, path, value) {
  const parts = path.split(".");
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part]) {
      current[part] = { subcommands: {} };
    }
    if (!current[part].subcommands) {
      current[part].subcommands = {};
    }
    current = current[part].subcommands;
  }

  const lastPart = parts[parts.length - 1];
  current[lastPart] = value;
}

/**
 * Get value at nested path in object
 */
function getNestedValue(obj, path) {
  const parts = path.split(".");
  let current = obj;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (i === 0) {
      current = current[part];
    } else {
      current = current?.subcommands?.[part];
    }
    if (!current) return undefined;
  }

  return current;
}

/**
 * Category descriptions for the CLI schema
 */
const CATEGORY_DESCRIPTIONS = {
  "smart-money": "Smart Money analytics - track sophisticated market participants",
  profiler: "Wallet profiling - detailed information about any blockchain address",
  token: "Token God Mode - deep analytics for any token",
  portfolio: "Portfolio analytics",
  perp: "Perpetual futures analytics",
  search: "Search for tokens and entities across Nansen",
  points: "Nansen Points analytics",
};

/**
 * Command description overrides (shorter, CLI-style)
 */
const DESCRIPTION_OVERRIDES = {
  "smart-money.netflow": "Net capital flows (inflows vs outflows)",
  "smart-money.dex-trades": "Real-time DEX trading activity",
  "smart-money.perp-trades": "Perpetual trading on Hyperliquid",
  "smart-money.holdings": "Aggregated token balances",
  "smart-money.dcas": "DCA strategies on Jupiter",
  "smart-money.historical-holdings": "Historical holdings over time",
  "profiler.transactions": "Transaction history",
  "profiler.balance": "Current token holdings",
  "profiler.labels": "Behavioral and entity labels",
  "profiler.pnl": "PnL and trade performance",
  "profiler.pnl-summary": "Summarized PnL metrics",
  "profiler.counterparties": "Top counterparties by volume",
  "profiler.historical-balances": "Historical balances over time",
  "profiler.related-wallets": "Find wallets related to an address",
  "profiler.perp-positions": "Current perpetual positions",
  "profiler.perp-trades": "Perpetual trading history",
  "token.flows": "Token flow metrics",
  "token.holders": "Token holder analysis",
  "token.dex-trades": "DEX trading activity",
  "token.transfers": "Token transfer history",
  "token.pnl": "PnL leaderboard",
  "token.who-bought-sold": "Recent buyers and sellers",
  "token.flow-intelligence": "Detailed flow intelligence by label",
  "token.perp-positions": "Open perp positions by token symbol",
  "token.perp-trades": "Perp trades by token symbol",
  "token.perp-pnl-leaderboard": "Perp PnL leaderboard by token",
  "token.info": "Get detailed information for a specific token",
  "token.ohlcv": "OHLCV candle data for a token",
  "token.indicators": "Risk and reward indicators for a token (Nansen Score)",
  "token.screener": "Discover and filter tokens",
  "token.jup-dca": "Jupiter DCA orders for token",
  "portfolio.defi": "DeFi holdings across protocols",
  "perp.screener": "Screen perpetual futures contracts",
  "perp.leaderboard": "Perpetual futures PnL leaderboard",
  search: "Search for tokens and entities across Nansen",
};

/**
 * Build CLI schema from OpenAPI spec
 */
function buildSchemaFromOpenAPI(openAPISpec, overrides, currentSchema) {
  const paths = openAPISpec.paths || {};
  const newCommands = { research: { description: "Research and analytics commands", subcommands: {} } };
  const warnings = [];

  // Process each API path
  for (const [apiPath, methods] of Object.entries(paths)) {
    const method = methods.post || methods.get;
    if (!method) continue;

    const commandPath = apiPathToCommandPath(apiPath, overrides);
    if (!commandPath) {
      // Explicitly excluded
      continue;
    }

    // Extract params and returns from OpenAPI
    const params = extractParams(method.requestBody);
    const returns = extractReturns(method.responses);

    // Apply overrides
    const options = applyOverrides(commandPath, params, overrides);

    // Get CLI-style description
    const shortCommandPath = commandPath.replace("research.", "");
    const cliDescription =
      DESCRIPTION_OVERRIDES[shortCommandPath] ||
      method.summary ||
      method.description ||
      "";

    // Build command object
    const command = {
      description: cliDescription,
      options,
    };

    if (returns.length > 0) {
      command.returns = returns;
    }

    // Set in new schema
    setNestedValue(newCommands, commandPath, command);
  }

  // Ensure parent categories have descriptions
  for (const [category, desc] of Object.entries(CATEGORY_DESCRIPTIONS)) {
    const categoryCmd = newCommands.research.subcommands[category];
    if (categoryCmd && !categoryCmd.description) {
      categoryCmd.description = desc;
    }
  }

  // Merge with CLI-only commands from current schema
  const cliOnlyPaths = Object.keys(overrides.preserve?.cliOnlyCommands || {});
  for (const cliPath of cliOnlyPaths) {
    const fullPath = `research.${cliPath.replace("/", ".")}`;
    const existing = getNestedValue(currentSchema.commands, fullPath);
    if (existing) {
      setNestedValue(newCommands, fullPath, existing);
    }
  }

  // Check for endpoints in current schema but not in new (warn about removals)
  const currentCommands = flattenCommands(currentSchema.commands.research, "research");
  const newCommandsList = flattenCommands(newCommands.research, "research");

  for (const cmd of currentCommands) {
    if (!newCommandsList.includes(cmd) && !cliOnlyPaths.some((p) => cmd.includes(p.replace("/", ".")))) {
      warnings.push(`[warn] Command '${cmd}' exists in current schema but not in OpenAPI spec`);
    }
  }

  // Check for new endpoints
  for (const cmd of newCommandsList) {
    if (!currentCommands.includes(cmd)) {
      warnings.push(`[new] Command '${cmd}' added from OpenAPI spec`);
    }
  }

  return { commands: newCommands, warnings };
}

/**
 * Flatten command tree to list of paths
 */
function flattenCommands(obj, prefix = "") {
  const paths = [];

  for (const [name, value] of Object.entries(obj?.subcommands || obj || {})) {
    if (name === "description" || name === "options" || name === "returns") continue;

    const path = prefix ? `${prefix}.${name}` : name;

    if (value.subcommands) {
      paths.push(...flattenCommands(value, path));
    } else if (value.options || value.returns) {
      paths.push(path);
    }
  }

  return paths;
}

/**
 * Merge new schema with preserved sections
 */
function mergeWithPreserved(newSchema, currentSchema, overrides) {
  const result = {
    commands: {
      ...newSchema.commands,
    },
  };

  // Preserve trade command
  if (currentSchema.commands.trade) {
    result.commands.trade = currentSchema.commands.trade;
  }

  // Preserve globalOptions
  if (overrides.preserve?.globalOptions && currentSchema.globalOptions) {
    result.globalOptions = currentSchema.globalOptions;
  }

  // Preserve chains
  if (overrides.preserve?.chains && currentSchema.chains) {
    result.chains = currentSchema.chains;
  }

  // Preserve smartMoneyLabels
  if (overrides.preserve?.smartMoneyLabels && currentSchema.smartMoneyLabels) {
    result.smartMoneyLabels = currentSchema.smartMoneyLabels;
  }

  return result;
}

/**
 * Generate diff between two objects
 */
function generateDiff(oldObj, newObj, _path = "") {
  const diffs = [];

  const oldStr = JSON.stringify(oldObj, null, 2);
  const newStr = JSON.stringify(newObj, null, 2);

  if (oldStr === newStr) {
    return diffs;
  }

  // Simple line-by-line diff
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  let i = 0,
    j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i >= oldLines.length) {
      diffs.push(`+ ${newLines[j]}`);
      j++;
    } else if (j >= newLines.length) {
      diffs.push(`- ${oldLines[i]}`);
      i++;
    } else if (oldLines[i] === newLines[j]) {
      diffs.push(`  ${oldLines[i]}`);
      i++;
      j++;
    } else {
      // Look ahead to find matching line
      let foundInNew = newLines.slice(j, j + 5).indexOf(oldLines[i]);
      let foundInOld = oldLines.slice(i, i + 5).indexOf(newLines[j]);

      if (foundInNew > 0) {
        // Lines added in new
        for (let k = 0; k < foundInNew; k++) {
          diffs.push(`+ ${newLines[j + k]}`);
        }
        j += foundInNew;
      } else if (foundInOld > 0) {
        // Lines removed from old
        for (let k = 0; k < foundInOld; k++) {
          diffs.push(`- ${oldLines[i + k]}`);
        }
        i += foundInOld;
      } else {
        diffs.push(`- ${oldLines[i]}`);
        diffs.push(`+ ${newLines[j]}`);
        i++;
        j++;
      }
    }
  }

  // Filter to only show changed lines with context
  return filterDiffWithContext(diffs, 3);
}

/**
 * Filter diff to show only changes with context
 */
function filterDiffWithContext(diffs, contextLines = 3) {
  const result = [];
  const changeIndices = [];

  // Find all change indices
  for (let i = 0; i < diffs.length; i++) {
    if (diffs[i].startsWith("+") || diffs[i].startsWith("-")) {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) {
    return ["No changes detected."];
  }

  // Build ranges with context
  const ranges = [];
  let currentRange = null;

  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(diffs.length - 1, idx + contextLines);

    if (!currentRange) {
      currentRange = { start, end };
    } else if (start <= currentRange.end + 1) {
      currentRange.end = end;
    } else {
      ranges.push(currentRange);
      currentRange = { start, end };
    }
  }
  if (currentRange) {
    ranges.push(currentRange);
  }

  // Output ranges with separators
  for (let r = 0; r < ranges.length; r++) {
    if (r > 0) {
      result.push("...");
    }
    for (let i = ranges[r].start; i <= ranges[r].end; i++) {
      result.push(diffs[i]);
    }
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: node scripts/sync-schema.js [options]

Options:
  --apply    Apply changes to src/schema.json (default: preview only)
  --help     Show this help message

Examples:
  node scripts/sync-schema.js          # Preview diff
  node scripts/sync-schema.js --apply  # Apply changes
`);
    process.exit(0);
  }

  const applyChanges = args.includes("--apply");

  try {
    // Load inputs
    const [openAPISpec, overrides, currentSchema] = await Promise.all([
      fetchOpenAPISpec(),
      loadOverrides(),
      loadCurrentSchema(),
    ]);

    console.error(`[sync-schema] Loaded OpenAPI spec with ${Object.keys(openAPISpec.paths || {}).length} paths`);
    console.error(`[sync-schema] Current schema has ${flattenCommands(currentSchema.commands.research, "research").length} research commands`);

    // Build new schema
    const { commands: newCommands, warnings } = buildSchemaFromOpenAPI(
      openAPISpec,
      overrides,
      currentSchema
    );

    // Print warnings
    for (const warning of warnings) {
      console.error(warning);
    }

    // Merge with preserved sections
    const finalSchema = mergeWithPreserved(
      { commands: newCommands },
      currentSchema,
      overrides
    );

    // Generate and print diff
    console.error("\n[sync-schema] Diff preview:\n");
    const diff = generateDiff(currentSchema, finalSchema);

    const hasChanges = diff.some((line) => line.startsWith("+") || line.startsWith("-"));

    if (!hasChanges) {
      console.log("No changes detected. Schema is up to date.");
      process.exit(0);
    }

    // Print diff (limited for preview)
    const maxLines = 100;
    const diffOutput = diff.slice(0, maxLines);
    console.log(diffOutput.join("\n"));
    if (diff.length > maxLines) {
      console.log(`... (${diff.length - maxLines} more lines)`);
    }

    if (applyChanges) {
      fs.writeFileSync(SCHEMA_PATH, JSON.stringify(finalSchema, null, 2) + "\n");
      console.error(`\n[sync-schema] Changes applied to ${SCHEMA_PATH}`);
    } else {
      console.error("\n[sync-schema] Preview only. Run with --apply to write changes.");
    }
  } catch (err) {
    console.error(`[sync-schema] Error: ${err.message}`);
    process.exit(1);
  }
}

main();
