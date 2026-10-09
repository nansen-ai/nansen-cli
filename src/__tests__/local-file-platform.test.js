import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createWallet } from '../wallet.js';

it('uses a saved API key and reads a CLI-generated quote through a dry run', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-platform-'));
  const requests = [];
  const quote = { success: true, metadata: { quoteId: 'backend-quote-id' }, quotes: [{
    aggregator: 'lifi', inputMint: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    outputMint: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    inAmount: '1000000000000000000', outAmount: '3000000000',
    transaction: { to: '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae', data: '0x12345678',
      value: '1000000000000000000', gas: '100000', maxFeePerGas: '1000000', maxPriorityFeePerGas: '1000000' },
  }] };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, key: req.headers.apikey, method: body.method });
    let response = { data: [] };
    if (req.url.startsWith('/quote')) response = quote;
    else if (req.url.includes('/sanctions/screen')) response = { results: body.addresses.map(address => ({ address, sanctioned: false })) };
    else if (body.method) {
      const results = { eth_getCode: '0x6080604052', eth_call: '0x', eth_estimateGas: '0x186a0',
        eth_getBalance: '0x100000000000000000000', eth_getTransactionCount: '0x5', eth_getBlockByNumber: { baseFeePerGas: '0x1' } };
      response = { jsonrpc: '2.0', id: body.id || 1, result: results[body.method] ?? null };
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, NANSEN_BASE_URL: origin,
    NANSEN_TRADING_API_URL: origin, NANSEN_BASE_RPC: origin, NANSEN_BASE_SIM_RPC: origin,
    NANSEN_NO_TELEMETRY: '1', DO_NOT_TRACK: '1', NO_UPDATE_NOTIFIER: '1' };
  delete env.NANSEN_API_KEY;
  async function cli(args) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url)), ...args], { env });
    let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill(), 20000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      expect(code, out).toBe(0); return out;
    } finally { clearTimeout(timer); }
  }
  try {
    vi.stubEnv('HOME', home);
    createWallet('smoke', 'fixture-password');
    fs.writeFileSync(path.join(home, '.nansen', 'config.json'), JSON.stringify({ apiKey: 'fixture-saved-key' }), { mode: 0o600 });
    await cli(['research', 'token', 'screener', '--chain', 'base']);
    expect(requests.some(req => req.key === 'fixture-saved-key')).toBe(true);
    const output = await cli(['trade', 'quote', '--chain', 'base', '--from', 'ETH', '--to', 'USDC', '--amount', '1000000000000000000', '--wallet', 'smoke']);
    const id = output.match(/Quote ID:\s+(\S+)/)?.[1]; expect(id).toBeTruthy();
    const plan = await cli(['trade', 'execute', '--quote', id, '--dry-run']);
    expect(plan).toContain('Trade plan');
    expect(fs.existsSync(path.join(home, '.nansen', 'quotes', `${id}.json`))).toBe(true);
    expect(requests.some(req => req.url.startsWith('/execute') || req.method === 'eth_sendRawTransaction')).toBe(false);
  } finally {
    vi.unstubAllEnvs(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
