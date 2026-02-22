/**
 * Nansen CLI - Privy Wallet Provider
 * Create and manage agentic wallets via Privy's server wallet API.
 * Requires PRIVY_APP_ID and PRIVY_APP_SECRET environment variables.
 * 
 * Docs: https://docs.privy.io/guide/server-wallets
 * Skill: https://github.com/privy-io/privy-agentic-wallets-skill
 */

const PRIVY_BASE_URL = 'https://api.privy.io';

export class PrivyWalletProvider {
  constructor() {
    this.appId = process.env.PRIVY_APP_ID;
    this.appSecret = process.env.PRIVY_APP_SECRET;
    if (!this.appId || !this.appSecret) {
      throw new Error(
        'Privy credentials required. Set PRIVY_APP_ID and PRIVY_APP_SECRET.\n' +
        'Get them from https://dashboard.privy.io → Settings → Basics'
      );
    }
  }

  get headers() {
    const credentials = Buffer.from(`${this.appId}:${this.appSecret}`).toString('base64');
    return {
      'Authorization': `Basic ${credentials}`,
      'privy-app-id': this.appId,
      'Content-Type': 'application/json',
    };
  }

  async request(method, path, body = null) {
    const url = `${PRIVY_BASE_URL}${path}`;
    const options = { method, headers: this.headers };
    if (body && (method === 'POST' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const msg = data?.message || data?.error || `Privy API error (${response.status})`;
      throw new Error(msg);
    }
    return data;
  }

  // ---- Wallet CRUD ----

  async createWallet({ chainType = 'ethereum', policyIds } = {}) {
    const body = { chain_type: chainType };
    if (policyIds?.length) body.policy_ids = policyIds;
    return this.request('POST', '/v1/wallets', body);
  }

  async listWallets({ chainType, limit = 20, cursor } = {}) {
    const params = new URLSearchParams();
    if (chainType) params.set('chain_type', chainType);
    if (limit) params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const qs = params.toString();
    return this.request('GET', `/v1/wallets${qs ? '?' + qs : ''}`);
  }

  async getWallet(walletId) {
    return this.request('GET', `/v1/wallets/${walletId}`);
  }

  async deleteWallet(walletId) {
    return this.request('DELETE', `/v1/wallets/${walletId}`);
  }

  async getBalance(walletId) {
    return this.request('GET', `/v1/wallets/${walletId}/balance`);
  }

  // ---- Transactions ----

  async sendTransaction(walletId, { caip2, transaction }) {
    return this.request('POST', `/v1/wallets/${walletId}/rpc`, {
      method: 'eth_sendTransaction',
      caip2,
      params: { transaction },
    });
  }

  async signTransaction(walletId, { caip2, transaction }) {
    // Solana uses signTransaction, EVM uses eth_signTransaction
    const isSolana = caip2?.startsWith('solana:');
    return this.request('POST', `/v1/wallets/${walletId}/rpc`, {
      method: isSolana ? 'signTransaction' : 'eth_signTransaction',
      caip2,
      params: isSolana ? { transaction } : { transaction },
    });
  }

  async signMessage(walletId, { message }) {
    return this.request('POST', `/v1/wallets/${walletId}/rpc`, {
      method: 'personal_sign',
      params: { message },
    });
  }

  // ---- Policies ----

  async createPolicy({ name, chainType = 'ethereum', rules = [] }) {
    return this.request('POST', '/v1/policies', {
      name,
      chain_type: chainType,
      default_action: 'DENY',
      rules,
    });
  }

  async listPolicies() {
    return this.request('GET', '/v1/policies');
  }

  async getPolicy(policyId) {
    return this.request('GET', `/v1/policies/${policyId}`);
  }

  async deletePolicy(policyId) {
    return this.request('DELETE', `/v1/policies/${policyId}`);
  }

  async updateWalletPolicy(walletId, policyIds) {
    return this.request('PATCH', `/v1/wallets/${walletId}`, {
      policy_ids: policyIds,
    });
  }
}

// ---- CAIP-2 chain identifiers ----
export const CHAIN_CAIP2 = {
  'ethereum': 'eip155:1',
  'base': 'eip155:8453',
  'arbitrum': 'eip155:42161',
  'optimism': 'eip155:10',
  'polygon': 'eip155:137',
  'avalanche': 'eip155:43114',
  'bnb': 'eip155:56',
  'linea': 'eip155:59144',
  'scroll': 'eip155:534352',
  'solana': 'solana:mainnet',
};

export default PrivyWalletProvider;
