/**
 * Nansen CLI - The one list of error codes.
 *
 * Every failure the CLI reports carries one of these codes in the `code` field
 * of the error envelope ({ success: false, error, code, status, details }).
 * Agents branch on `code`, so a code must never appear in the source without
 * an entry here: src/__tests__/error-code-registry.test.js scans the source and
 * fails on an unregistered code, and docs/error-codes.md is generated from this
 * table (`npm run error-codes:generate`; `npm test` fails when it is stale).
 *
 * Field-level validation errors also carry `details.errors[]` entries
 * ({ field, message, code }) whose `code` uses the API's snake_case set
 * (FIELD_ERROR_CODES below), so the CLI, the REST API and the MCP server
 * describe one bad field the same way.
 */

/** Group order and headings for the generated documentation. */
export const ERROR_CODE_GROUPS = {
  input: 'Input and validation',
  auth: 'Authentication and access',
  quota: 'Credits, plans and rate limits',
  api: 'API, network and server',
  session: 'Browser login and saved sessions',
  wallet: 'Wallets and passwords',
  trade: 'Trading, quotes and simulation',
  bridge: 'Bridge',
  perp: 'Perpetuals (Hyperliquid)',
  local: 'Local files, config and tooling',
  generic: 'Generic',
};

/**
 * code -> { group, description }. `retry` is set where retrying the same
 * request can succeed without changing it.
 */
export const ERROR_CODES = {
  // ── Input and validation ──
  INVALID_PARAMS: { group: 'input', description: 'An option or request field has an invalid value, or the command does not accept it. `details.errors[]` names each field.' },
  MISSING_PARAM: { group: 'input', description: 'A required option or request field is missing. `details.errors[]` names each field.' },
  MISSING_ARGS: { group: 'input', description: 'A trade or wallet command is missing required arguments; the message shows the usage.' },
  INVALID_INPUT: { group: 'input', description: 'A trade, bridge, perp or wallet argument failed local validation.' },
  INVALID_ADDRESS: { group: 'input', description: 'An address does not match the format of the selected chain.' },
  INVALID_TOKEN: { group: 'input', description: 'A token address or symbol is not valid for the selected chain.' },
  INVALID_CHAIN: { group: 'input', description: 'The chain is not known or not supported (legacy; supported-chain errors now use INVALID_PARAMS with the field named).' },
  INVALID_AMOUNT: { group: 'input', description: 'An amount is zero, negative or not a whole number of base units.' },
  INVALID_SLIPPAGE: { group: 'input', description: 'The slippage value is outside the allowed range.' },
  INVALID_AGGREGATOR: { group: 'input', description: 'The --aggregator value is not one of the supported aggregators.' },
  INVALID_QUOTE_INDEX: { group: 'input', description: 'The --quote-index does not select a quote in the saved quote.' },
  UNSUPPORTED_FILTER: { group: 'input', description: 'The API does not support this filter for the token or chain. Do not retry.' },
  QUERY_TOO_LARGE: { group: 'input', description: 'The query would return too much data. Narrow it; retrying does not help.' },
  PAYLOAD_TOO_LARGE: { group: 'input', description: 'The request body is larger than the API accepts (HTTP 413).' },
  UNKNOWN_COMMAND: { group: 'input', description: 'The command or subcommand does not exist. The message suggests the closest match and `details.available` lists the valid ones.' },
  COMMAND_UNAVAILABLE: { group: 'input', description: 'The command was removed or is not available in this version.' },
  GASLESS_REMOVED: { group: 'input', description: 'The removed --gasless flag was passed to trade execute.' },

  // ── Authentication and access ──
  UNAUTHORIZED: { group: 'auth', description: 'The API rejected the credential (HTTP 401): the API key is missing, invalid or revoked. Not a connection problem.' },
  INVALID_API_KEY: { group: 'auth', description: 'login could not verify the API key because the API rejected it.' },
  API_KEY_REQUIRED: { group: 'auth', description: 'No API key was provided where one is required.' },
  VERIFICATION_FAILED: { group: 'auth', description: 'login could not verify the API key for a reason other than a rejected key (network, rate limit, outage). The key may be valid.' },
  FORBIDDEN: { group: 'auth', description: 'The credential is valid but has no permission for this endpoint (HTTP 403).' },
  GEO_BLOCKED: { group: 'auth', description: 'The endpoint is not available in the caller\'s region (HTTP 451).' },
  NOT_A_TTY: { group: 'auth', description: 'An interactive step (prompt or browser login) needs a terminal, but stdin or stdout is not one.' },
  MIXED_CREDENTIALS: { group: 'auth', description: 'A browser-session request was combined with an API key or payment signature.' },

  // ── Credits, plans and rate limits ──
  CREDITS_EXHAUSTED: { group: 'quota', description: 'The account has no API credits left. Retrying does not help.' },
  PLAN_UPGRADE_REQUIRED: { group: 'quota', description: 'The account plan does not include this endpoint.' },
  PAYMENT_REQUIRED: { group: 'quota', description: 'The request needs an x402 payment and no payment could be made (HTTP 402).' },
  PAYMENT_AMBIGUOUS: { group: 'quota', description: 'An x402 payment was sent but its outcome is unknown. Do not retry with another payment.' },
  RATE_LIMITED: { group: 'quota', description: 'Too many requests (HTTP 429). Wait `details.retryAfterMs` before retrying.', retry: true },

  // ── API, network and server ──
  NETWORK_ERROR: { group: 'api', description: 'The CLI could not reach the API (DNS, TLS, proxy, firewall or offline). The credential was not checked; do not replace the API key.', retry: true },
  TIMEOUT: { group: 'api', description: 'The request or query timed out.', retry: true },
  SERVER_ERROR: { group: 'api', description: 'The API failed with an internal error (HTTP 5xx). Quote `requestId` to support.', retry: true },
  SERVICE_UNAVAILABLE: { group: 'api', description: 'The API or an upstream service is temporarily unavailable (HTTP 503).', retry: true },
  NOT_FOUND: { group: 'api', description: 'The resource or endpoint was not found (HTTP 404).' },
  TOKEN_NOT_FOUND: { group: 'api', description: 'The token was not found (HTTP 404).' },
  ADDRESS_NOT_FOUND: { group: 'api', description: 'The address has no data (HTTP 404).' },
  METHOD_NOT_ALLOWED: { group: 'api', description: 'The HTTP method is not allowed for this endpoint (HTTP 405).' },
  CONFLICT: { group: 'api', description: 'The request conflicts with the current state of the resource (HTTP 409).' },
  NON_JSON_RESPONSE: { group: 'api', description: 'A trading or limit-order service answered with a body that is not JSON.', retry: true },
  LIMIT_ORDER_NETWORK_ERROR: { group: 'api', description: 'The CLI could not reach the limit-order service.', retry: true },

  // ── Browser login and saved sessions ──
  AUTH_BUNDLE_TOO_LARGE: { group: 'session', description: 'The issued session is larger than secure storage allows. The previous credential is unchanged.' },
  AUTH_BUSY: { group: 'session', description: 'Another authentication operation is running. Retry after it finishes.', retry: true },
  AUTH_CANCELLED: { group: 'session', description: 'The authentication operation was cancelled.' },
  AUTH_CLEANUP_REQUIRED: { group: 'session', description: 'Old login journals need cleanup. Unlock the credential store and run nansen logout.' },
  AUTH_CONNECT_UNAVAILABLE: { group: 'session', description: 'The CLI could not connect to the authentication service.', retry: true },
  AUTH_HOME_UNAVAILABLE: { group: 'session', description: 'No absolute home directory was found. Set HOME or USERPROFILE.' },
  AUTH_JOURNAL_INVALID: { group: 'session', description: 'A login recovery journal is corrupt.' },
  AUTH_LOCK_UNAVAILABLE: { group: 'session', description: 'Native file locking is not available on this platform, so saved authentication cannot be written.' },
  AUTH_NETWORK_ERROR: { group: 'session', description: 'A network error occurred during browser login.', retry: true },
  AUTH_ORIGIN_MISMATCH: { group: 'session', description: 'The saved session or simulation endpoint does not match the selected API origin.' },
  AUTH_ORIGIN_UNSUPPORTED: { group: 'session', description: 'Browser sessions need the Nansen production or staging API origin.' },
  AUTH_SELECTION_CHANGED: { group: 'session', description: 'The saved credential changed while the command ran. Retry the command.', retry: true },
  AUTH_STATE_INVALID: { group: 'session', description: 'The saved authentication state is invalid.' },
  AUTH_STORE_UNAVAILABLE: { group: 'session', description: 'The OS credential store is unavailable or locked.' },
  AUTH_TIMEOUT: { group: 'session', description: 'An authentication operation timed out.', retry: true },
  BROWSER_SESSION_SETUP_REQUIRED: { group: 'session', description: 'The session issuer configuration is not compatible with this CLI.' },
  INVALID_BROWSER_SESSION: { group: 'session', description: 'The API rejected the new browser session. Run nansen login again.' },
  PAIRING_CANCELLED: { group: 'session', description: 'Browser login was cancelled before approval.' },
  PAIRING_DENIED: { group: 'session', description: 'Browser login was denied in the browser.' },
  PAIRING_EXPIRED: { group: 'session', description: 'The browser login code expired before approval.' },
  PAIRING_FAILED: { group: 'session', description: 'Browser login failed.' },
  SESSION_CLOCK_SKEW: { group: 'session', description: 'The session is not valid yet because the local clock is behind. Synchronize system time.' },
  SESSION_EXPIRED: { group: 'session', description: 'The browser access token expired and could not be renewed. Run nansen login.' },
  SESSION_REFRESH_PROTOCOL_ERROR: { group: 'session', description: 'The issuer rejected the session refresh request format.' },
  SESSION_REFRESH_REJECTED: { group: 'session', description: 'The saved session cannot be renewed. Run nansen login.' },
  SESSION_REFRESH_RETRYABLE: { group: 'session', description: 'Session renewal was refused before rotation. Retry later.', retry: true },
  SESSION_REFRESH_RETRY_EXHAUSTED: { group: 'session', description: 'Session renewal failed repeatedly. Run nansen login.' },
  SESSION_RENEWAL_STORAGE_ERROR: { group: 'session', description: 'The renewed session could not be stored. Retry the command.', retry: true },
  SESSION_RENEWAL_UNCERTAIN: { group: 'session', description: 'The outcome of session renewal is unknown. Run nansen login.' },
  SESSION_VERIFICATION_FAILED: { group: 'session', description: 'The CLI could not verify the account of a new browser session.' },

  // ── Wallets and passwords ──
  NO_WALLET: { group: 'wallet', description: 'No wallet (or WalletConnect session) is available for this chain.' },
  INVALID_WALLET: { group: 'wallet', description: 'The wallet cannot sign for this chain or action.' },
  PASSWORD_REQUIRED: { group: 'wallet', description: 'The wallet is encrypted and no password was found. `details` lists how to provide one.' },
  INCORRECT_PASSWORD: { group: 'wallet', description: 'The wallet password is wrong.' },
  NO_PASSWORD_FOUND: { group: 'wallet', description: 'No wallet password was found in any password store.' },
  KEYCHAIN_UNAVAILABLE: { group: 'wallet', description: 'The OS keychain is not available for the wallet password.' },
  CREATE_FAILED: { group: 'wallet', description: 'The wallet could not be created.' },
  DEFAULT_FAILED: { group: 'wallet', description: 'The default wallet could not be changed.' },
  DELETE_FAILED: { group: 'wallet', description: 'The wallet could not be deleted.' },
  EXPORT_FAILED: { group: 'wallet', description: 'The wallet could not be exported.' },
  SHOW_FAILED: { group: 'wallet', description: 'The wallet could not be shown.' },
  SEND_FAILED: { group: 'wallet', description: 'A native transfer failed.' },
  PRIVY_ERROR: { group: 'wallet', description: 'The Privy wallet service returned an error.' },

  // ── Trading, quotes and simulation ──
  NO_QUOTES: { group: 'trade', description: 'No aggregator returned a quote.' },
  ALL_QUOTES_FAILED: { group: 'trade', description: 'Every quote failed to execute.' },
  QUOTE_ERROR: { group: 'trade', description: 'The quote service returned an error.' },
  EXECUTE_ERROR: { group: 'trade', description: 'Trade execution failed.' },
  MISSING_QUOTE_ID: { group: 'trade', description: 'trade execute needs a --quote id.' },
  AGGREGATOR_NOT_AVAILABLE: { group: 'trade', description: 'The requested aggregator has no quote in the saved quote.' },
  MAX_INPUT_EXCEEDED: { group: 'trade', description: 'The quote would spend more than the allowed maximum input.' },
  NO_TRANSACTION: { group: 'trade', description: 'No quote contains transaction data.' },
  INVALID_EXECUTION_ROUTE: { group: 'trade', description: 'The quote has an execution route the CLI does not support.' },
  INSUFFICIENT_BALANCE: { group: 'trade', description: 'The wallet balance is too low for the trade.' },
  INSUFFICIENT_GAS: { group: 'trade', description: 'The wallet has too little native token for gas.' },
  WALLET_MISMATCH: { group: 'trade', description: 'The quote was built for a different wallet.' },
  AMOUNT_MISMATCH: { group: 'trade', description: 'The quote or bridge amount differs from the requested amount.' },
  INVALID_SIGNED_TX: { group: 'trade', description: 'The signed transaction is not valid.' },
  BROADCAST_FAILED: { group: 'trade', description: 'The transaction could not be broadcast.' },
  TX_REVERTED: { group: 'trade', description: 'The transaction reverted on chain.' },
  TXHASH_MISMATCH: { group: 'trade', description: 'The RPC returned a different transaction hash than the one signed.' },
  RECEIPT_TIMEOUT: { group: 'trade', description: 'No transaction receipt arrived in time. Check the transaction before retrying.' },
  OUTCOME_VERIFICATION_FAILED: { group: 'trade', description: 'The CLI could not verify the trade outcome.' },
  SWAP_OUTCOME_MISMATCH: { group: 'trade', description: 'The simulated swap outcome does not match the quote; nothing was signed.' },
  LIMIT_ORDER_DESTINATION_MISMATCH: { group: 'trade', description: 'The limit order sends funds to an unexpected destination; nothing was signed.' },
  LIMIT_ORDER_OUTCOME_MISMATCH: { group: 'trade', description: 'The simulated limit-order deposit does not match the order; nothing was signed.' },
  SIMULATION_FAILED: { group: 'trade', description: 'Pre-broadcast simulation failed; nothing was signed.' },
  SIMULATION_ACCESS_DENIED: { group: 'trade', description: 'The account cannot use hosted simulation.' },
  SIM_REVERTED: { group: 'trade', description: 'The transaction reverts in simulation.' },
  SIM_RPC_ERROR: { group: 'trade', description: 'The simulation RPC returned an error.' },
  SIM_RESULT_UNPARSEABLE: { group: 'trade', description: 'The simulation result could not be parsed.' },
  NO_SIM_RPC: { group: 'trade', description: 'No simulation RPC is configured for the chain.' },
  NOT_SIM_CAPABLE: { group: 'trade', description: 'The RPC does not support simulation.' },
  RPC_UNCONFIGURED: { group: 'trade', description: 'No RPC URL is configured for the chain.' },
  RPC_HTTP_ERROR: { group: 'trade', description: 'The RPC answered with an HTTP or JSON-RPC error.' },
  RPC_JSON_ERROR: { group: 'trade', description: 'The RPC answered with a body that is not JSON.' },
  RPC_NETWORK_ERROR: { group: 'trade', description: 'The CLI could not reach the RPC.', retry: true },
  CONFIRMATION_DECLINED: { group: 'trade', description: 'The confirmation prompt was declined; nothing was signed.' },
  CONFIRMATION_UNAVAILABLE: { group: 'trade', description: 'Confirmation is required but no terminal is available. Pass --yes to confirm.' },

  // ── Bridge ──
  BRIDGE_FAILED: { group: 'bridge', description: 'The bridge transfer failed.' },
  BRIDGE_NOT_FOUND: { group: 'bridge', description: 'No bridge request was found for the id.' },
  BRIDGE_STATUS_ERROR: { group: 'bridge', description: 'The bridge status could not be read.', retry: true },
  BRIDGE_TIMEOUT: { group: 'bridge', description: 'The bridge transfer did not finish in time. Check nansen bridge status.' },
  QUOTE_STATE_UNSAFE: { group: 'bridge', description: 'The bridge execution could not be recorded safely. Check nansen bridge status before requesting a new quote.' },
  SIGNER_MISMATCH: { group: 'bridge', description: 'The bridge quote expects a different signer.' },
  UNEXPECTED_ACTION: { group: 'bridge', description: 'The bridge quote contains an action the CLI does not expect.' },
  UNEXPECTED_NETWORK: { group: 'bridge', description: 'The bridge quote uses an unexpected network.' },
  PARTIAL_FILL: { group: 'bridge', description: 'The bridge transfer was only partly filled.' },
  HL_ACTION_REJECTED: { group: 'bridge', description: 'Hyperliquid rejected the action.' },

  // ── Perpetuals ──
  BUILDER_FEE_TOO_HIGH: { group: 'perp', description: 'The builder fee is above the allowed ceiling.' },
  BUILDER_FEE_UNAVAILABLE: { group: 'perp', description: 'The builder fee could not be read or approved.' },
  META_UNAVAILABLE: { group: 'perp', description: 'Hyperliquid asset metadata is not available.', retry: true },
  SANCTIONED: { group: 'perp', description: 'The address failed sanctions screening.' },
  SCREENING_UNAVAILABLE: { group: 'perp', description: 'Sanctions screening is not available, so the action was refused.', retry: true },
  UNSUPPORTED_NETWORK: { group: 'perp', description: 'The network is not supported for this perp action.' },
  ZERO_PRICE: { group: 'perp', description: 'The order price rounds to zero.' },
  ZERO_SIZE: { group: 'perp', description: 'The order size rounds to zero.' },

  // ── Local files, config and tooling ──
  FILE_EXISTS: { group: 'local', description: 'The output path already exists; the CLI does not overwrite it.' },
  FILE_WRITE_FAILED: { group: 'local', description: 'The output file could not be written.' },
  LOCAL_FILE_UNSAFE: { group: 'local', description: 'A local file has unsafe permissions or type.' },
  INVALID_CONFIG: { group: 'local', description: 'A configuration file could not be read or parsed.' },
  MCP_VERIFY_FAILED: { group: 'local', description: 'nansen mcp verify could not connect to the MCP server with the configured settings.' },
  UNSUPPORTED_PLATFORM: { group: 'local', description: 'The MCP client is not available on this operating system.' },

  // ── Generic ──
  COMMAND_ERROR: { group: 'generic', description: 'A command failed without a more specific code.' },
  UNKNOWN: { group: 'generic', description: 'An unexpected error with no code. Report it with the message.' },
};

/**
 * Codes that `details.errors[].code` can carry. They are the API's own
 * field-level codes (https://docs.nansen.ai/getting-started/error-handling),
 * reused for the CLI's local checks so one bad field reads the same on every
 * surface.
 */
export const FIELD_ERROR_CODES = {
  missing_field: 'A required field or option is missing.',
  unknown_field: 'The field or option is not recognized. The message suggests the closest valid name.',
  invalid_field_value: 'The value is not valid for the field (wrong type, not an allowed value, or a chain the command does not support).',
  invalid_address_format: 'The address does not match the chain\'s format.',
  invalid_date_format: 'The date is not a valid YYYY-MM-DD date.',
  invalid_date_range: 'The date range is not allowed.',
  mutually_exclusive_fields: 'Two fields that cannot be combined were both given.',
  value_out_of_range: 'The value is outside the allowed range.',
  too_many_items: 'The list has more items than allowed.',
};

/** Code name -> code string, for `ErrorCode.X` references. */
export const ErrorCode = Object.freeze(
  Object.fromEntries(Object.keys(ERROR_CODES).map(code => [code, code])),
);
