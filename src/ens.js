/**
 * ENS (Ethereum Name Service) resolution
 * Resolves .eth names to addresses using public APIs with onchain RPC fallback.
 * Zero external dependencies.
 */

import http from 'http';
import https from 'https';
import { keccak256 } from './crypto.js';
import { EVM_CHAINS } from './chain-ids.js';
import { CHAIN_RPCS } from './rpc-urls.js';

const ENS_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.eth$/;

/**
 * Check if a string looks like an ENS name
 */
export function isEnsName(name) {
  return typeof name === 'string' && ENS_PATTERN.test(name.trim());
}

/**
 * Resolve an address input — if it's an ENS name, resolve it; otherwise pass through.
 *
 * @param {string} addressOrName - Address (0x...) or ENS name (*.eth)
 * @param {string} chain - Chain context (ENS only resolves on EVM chains)
 * @returns {Promise<{address: string, ensName?: string}>}
 */
export async function resolveAddress(addressOrName, chain = 'ethereum') {
  if (!addressOrName || typeof addressOrName !== 'string') {
    return { address: addressOrName };
  }

  const trimmed = addressOrName.trim();

  if (!isEnsName(trimmed)) {
    return { address: trimmed };
  }

  // 'all' lets the API route by address format; a resolved .eth name is an
  // EVM address, so it resolves the same way an explicit EVM chain does.
  if (chain !== 'all' && !EVM_CHAINS.includes(chain)) {
    throw new Error(`ENS names can only be resolved on EVM chains, not ${chain}`);
  }

  const name = trimmed.toLowerCase();
  const errors = [];

  // Try ensideas API first (fast, no auth)
  try {
    const addr = await resolveViaEnsIdeas(name);
    if (addr) return { address: addr, ensName: name };
  } catch (e) {
    errors.push(`ensideas: ${e.message}`);
  }

  // Fallback: onchain resolution via public RPC
  try {
    const addr = await resolveOnchain(name);
    if (addr) return { address: addr, ensName: name };
  } catch (e) {
    errors.push(`onchain: ${e.message}`);
  }

  throw new Error(`Could not resolve ENS name: ${name}${errors.length ? ` (${errors.join('; ')})` : ''}`);
}

// ============= Resolvers =============

function httpsGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function httpsPost(url, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    // The URL can come from NANSEN_EVM_RPC, so keep its port and query string
    // (some providers put the key in `?key=`) and allow a plain-http local node.
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let buf = '';
      res.on('data', chunk => { buf += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

const VALID_ADDR = /^0x[0-9a-fA-F]{40}$/;

async function resolveViaEnsIdeas(name) {
  const result = await httpsGet(`https://api.ensideas.com/ens/resolve/${encodeURIComponent(name)}`);
  if (result?.address && VALID_ADDR.test(result.address)) return result.address;
  return null;
}

/**
 * Compute ENS namehash using keccak256 from crypto.js
 */
function namehash(name) {
  let node = Buffer.alloc(32, 0); // bytes32(0)
  if (!name) return node.toString('hex');

  const labels = name.split('.').reverse();
  for (const label of labels) {
    const labelHash = keccak256(Buffer.from(label, 'utf8'));
    node = keccak256(Buffer.concat([node, labelHash]));
  }
  return node.toString('hex');
}

const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
const ZERO_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

async function resolveOnchain(name) {
  const hash = namehash(name);
  // Same Ethereum RPC as every other command (NANSEN_EVM_RPC or the shared
  // default). The fallback used to be pinned to eth.llamarpc.com, which now
  // answers HTTP 525, and could not be pointed anywhere else.
  const rpcUrl = CHAIN_RPCS.ethereum;

  // Step 1: Get resolver from ENS registry — resolver(bytes32)
  const resolverResult = await httpsPost(rpcUrl, {
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to: ENS_REGISTRY, data: '0x0178b8bf' + hash }, 'latest']
  });

  const resolverHex = resolverResult?.result;
  if (!resolverHex || resolverHex === '0x' || resolverHex.slice(2) === ZERO_HASH) return null;

  const resolver = '0x' + resolverHex.slice(26);

  // Step 2: Call addr(bytes32) on the resolver — selector 0x3b3b57de
  const addrResult = await httpsPost(rpcUrl, {
    jsonrpc: '2.0', id: 2, method: 'eth_call',
    params: [{ to: resolver, data: '0x3b3b57de' + hash }, 'latest']
  });

  const addrHex = addrResult?.result;
  if (!addrHex || addrHex === '0x' || addrHex.slice(2) === ZERO_HASH) return null;

  const address = '0x' + addrHex.slice(26);
  return VALID_ADDR.test(address) ? address : null;
}
