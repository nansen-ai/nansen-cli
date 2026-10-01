#!/usr/bin/env node

/**
 * Generate the MCP section of README.md from src/mcp-client-config.json
 * (API-322).
 *
 *   npm run mcp:generate   rewrite the generated region in README.md
 *   npm run mcp:check      exit 1 if README.md differs from the generated output
 *
 * The region between the BEGIN/END GENERATED markers is rendered from
 * scripts/templates/readme-mcp.md. Change prose in the template and values in
 * the config file; never edit the region in README.md by hand. The output is a
 * pure function of those two files, so running the generator twice is a no-op.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MCP_CLIENT_CONFIG,
  buildClaudeCodeAddCommand,
  buildHttpEntry,
  buildStdioEntry,
  mcpRemoteSpec,
} from '../src/mcp-client-config.js';

export const README_PATH = fileURLToPath(new URL('../README.md', import.meta.url));
export const TEMPLATE_PATH = fileURLToPath(new URL('./templates/readme-mcp.md', import.meta.url));
export const REGION = 'mcp';
export const README_PLACEHOLDER = '<your-key>';

const FIX_HINT = 'Edit src/mcp-client-config.json (values) or scripts/templates/readme-mcp.md (prose), not README.md, then run: npm run mcp:generate';

const beginMarker = name => `<!-- BEGIN GENERATED: ${name}. Do not edit by hand. ${FIX_HINT}. -->`;
const endMarker = name => `<!-- END GENERATED: ${name} -->`;

const TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/** Replace every {{ name }}. Unknown names and leftover braces are errors. */
export function renderTemplate(template, values) {
  const rendered = template.replace(TOKEN, (_match, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Unknown template value "{{ ${name} }}" in ${TEMPLATE_PATH}`);
    return values[name];
  });
  const leftover = rendered.match(/\{\{[^}]*\}\}/);
  if (leftover) throw new Error(`Unrendered template token ${leftover[0]} in ${TEMPLATE_PATH}`);
  return rendered;
}

const mcpServers = (config, entry) => JSON.stringify({ mcpServers: { [config.serverKey]: entry } }, null, 2);
const linkText = url => url.replace(/^https:\/\//, '');

export function templateValues(config = MCP_CLIENT_CONFIG, placeholder = README_PLACEHOLDER) {
  return {
    endpoint: config.endpoint,
    endpointHost: new URL(config.endpoint).hostname,
    apiKeyHeader: config.apiKeyHeader,
    apiKeyEnvRef: `\${${config.apiKeyEnvVar}}`,
    apiKeySetupUrl: config.apiKeySetupUrl,
    apiKeySetupUrlText: linkText(config.apiKeySetupUrl),
    docsUrl: config.docsUrl,
    docsUrlText: linkText(config.docsUrl),
    mcpRemoteVersion: config.mcpRemote.version,
    mcpRemoteSpec: mcpRemoteSpec(config),
    claudeCodeCommand: buildClaudeCodeAddCommand(placeholder, { config }),
    httpJson: mcpServers(config, buildHttpEntry(placeholder, { config })),
    stdioJson: mcpServers(config, buildStdioEntry(placeholder, { config })),
  };
}

/**
 * Replace the content between one BEGIN/END pair. The BEGIN marker is found by
 * its prefix and rewritten, so a change to the hint text cannot orphan it.
 * Missing, repeated or out-of-order markers fail.
 */
export function replaceRegion(document, name, content) {
  const beginPrefix = `<!-- BEGIN GENERATED: ${name}.`;
  const end = endMarker(name);
  const beginAt = document.indexOf(beginPrefix);
  const endAt = document.indexOf(end);
  if (beginAt === -1 || endAt === -1) {
    throw new Error(`README.md is missing the "${name}" generated-region markers. Restore:\n${beginMarker(name)}\n...\n${end}`);
  }
  if (document.indexOf(beginPrefix, beginAt + 1) !== -1 || document.indexOf(end, endAt + 1) !== -1) {
    throw new Error(`README.md has more than one "${name}" generated region`);
  }
  const beginClose = document.indexOf('-->', beginAt);
  if (endAt < beginAt || beginClose === -1 || beginClose > endAt) {
    throw new Error(`README.md "${name}" markers are malformed or out of order`);
  }
  return `${document.slice(0, beginAt)}${beginMarker(name)}\n${content}${document.slice(endAt)}`;
}

export function generateReadme(readme, { config = MCP_CLIENT_CONFIG, template = fs.readFileSync(TEMPLATE_PATH, 'utf8').replace(/\r\n/g, '\n') } = {}) {
  return replaceRegion(readme, REGION, renderTemplate(template, templateValues(config)));
}

function firstDifference(actual, expected) {
  const a = actual.split('\n');
  const e = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, e.length); i += 1) {
    if (a[i] !== e[i]) {
      return `first difference at README.md line ${i + 1}:\n  found:    ${JSON.stringify(a[i] ?? '<end of file>')}\n  expected: ${JSON.stringify(e[i] ?? '<end of file>')}`;
    }
  }
  return 'no line difference';
}

/** Returns a non-empty message when README.md is stale, '' when it is current. */
export function checkReadme(readme, options) {
  const expected = generateReadme(readme, options);
  if (expected === readme) return '';
  return `README.md MCP section is out of date with src/mcp-client-config.json.\n${firstDifference(readme, expected)}\n${FIX_HINT}`;
}

function main(argv) {
  const check = argv.includes('--check');
  // .gitattributes pins LF; normalize anyway so a CRLF checkout compares equal.
  const readme = fs.readFileSync(README_PATH, 'utf8').replace(/\r\n/g, '\n');
  if (check) {
    const problem = checkReadme(readme);
    if (problem) {
      console.error(problem);
      return 1;
    }
    console.log('README.md MCP section is up to date.');
    return 0;
  }
  const updated = generateReadme(readme);
  if (updated === readme) {
    console.log('README.md MCP section is already up to date.');
  } else {
    fs.writeFileSync(README_PATH, updated);
    console.log('Updated README.md MCP section.');
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
