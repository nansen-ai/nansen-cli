<!-- Generated from src/error-codes.js by scripts/generate-error-codes-doc.js. Do not edit by hand; run: npm run error-codes:generate -->

# Error codes

Every failure exits with a non-zero status and prints one JSON envelope on stdout (with `--table` or `--format csv`, the same fields as text or CSV):

```json
{
  "success": false,
  "error": "Option '--timefrme' is not recognized by nansen research token info. Did you mean '--timeframe'?",
  "code": "INVALID_PARAMS",
  "status": null,
  "details": {
    "param": "--timefrme",
    "errors": [
      { "field": "--timefrme", "message": "Option '--timefrme' is not recognized by nansen research token info. Did you mean '--timeframe'?", "code": "unknown_field" }
    ]
  }
}
```

- `error` is the message. It is not repeated inside `details`.
- `code` is one of the codes below. Branch on it, not on the message.
- `status` is the HTTP status for an API error and `null` for a local error.
- `requestId` is present when the API returned one. Quote it to support.
- `details` carries the API's error body (for example `code`, `param`, `errors`, `doc_url`) or, for a local check, `param` and `errors`.
- `details.errors[]` lists each bad field or option as `{ field, message, code }`. For an API error, `field` is the request field (for example `body.chain`); for a local check, it is the option (for example `--chain`).

One exception: in an interactive terminal without `--pretty`, `--table`, `--format` or `--stream`, a local usage error (`MISSING_PARAM` or `MISSING_ARGS`) prints only its message. The exit status is still non-zero. Piped output always gets the envelope.

A connection failure is `NETWORK_ERROR` and never `UNAUTHORIZED`: the CLI could not reach the API, so it did not check the credential. Fix the connection; do not replace the API key.

## Codes

### Input and validation

| Code | Meaning | Retry |
| --- | --- | --- |
| `INVALID_PARAMS` | An option or request field has an invalid value, or the command does not accept it. `details.errors[]` names each field. | No |
| `MISSING_PARAM` | A required option or request field is missing. `details.errors[]` names each field. | No |
| `MISSING_ARGS` | A trade or wallet command is missing required arguments; the message shows the usage. | No |
| `INVALID_INPUT` | A trade, bridge, perp or wallet argument failed local validation. | No |
| `INVALID_ADDRESS` | An address does not match the format of the selected chain. | No |
| `INVALID_TOKEN` | A token address or symbol is not valid for the selected chain. | No |
| `INVALID_CHAIN` | The chain is not known or not supported (legacy; supported-chain errors now use INVALID_PARAMS with the field named). | No |
| `INVALID_AMOUNT` | An amount is zero, negative or not a whole number of base units. | No |
| `INVALID_SLIPPAGE` | The slippage value is outside the allowed range. | No |
| `INVALID_AGGREGATOR` | The --aggregator value is not one of the supported aggregators. | No |
| `INVALID_QUOTE_INDEX` | The --quote-index does not select a quote in the saved quote. | No |
| `UNSUPPORTED_FILTER` | The API does not support this filter for the token or chain. Do not retry. | No |
| `QUERY_TOO_LARGE` | The query would return too much data. Narrow it; retrying does not help. | No |
| `PAYLOAD_TOO_LARGE` | The request body is larger than the API accepts (HTTP 413). | No |
| `UNKNOWN_COMMAND` | The command or subcommand does not exist. The message suggests the closest match and `details.available` lists the valid ones. | No |
| `COMMAND_UNAVAILABLE` | The command was removed or is not available in this version. | No |
| `GASLESS_REMOVED` | The removed --gasless flag was passed to trade execute. | No |

### Authentication and access

| Code | Meaning | Retry |
| --- | --- | --- |
| `UNAUTHORIZED` | The API rejected the credential (HTTP 401): the API key is missing, invalid or revoked. Not a connection problem. | No |
| `INVALID_API_KEY` | login could not verify the API key because the API rejected it. | No |
| `API_KEY_REQUIRED` | No API key was provided where one is required. | No |
| `VERIFICATION_FAILED` | login could not verify the API key for a reason other than a rejected key (network, rate limit, outage). The key may be valid. | No |
| `FORBIDDEN` | The credential is valid but has no permission for this endpoint (HTTP 403). | No |
| `GEO_BLOCKED` | The endpoint is not available in the caller's region (HTTP 451). | No |
| `NOT_A_TTY` | An interactive step (prompt or browser login) needs a terminal, but stdin or stdout is not one. | No |
| `MIXED_CREDENTIALS` | A browser-session request was combined with an API key or payment signature. | No |

### Credits, plans and rate limits

| Code | Meaning | Retry |
| --- | --- | --- |
| `CREDITS_EXHAUSTED` | The account has no API credits left. Retrying does not help. | No |
| `PLAN_UPGRADE_REQUIRED` | The account plan does not include this endpoint. | No |
| `PAYMENT_REQUIRED` | The request needs an x402 payment and no payment could be made (HTTP 402). | No |
| `PAYMENT_AMBIGUOUS` | An x402 payment was sent but its outcome is unknown. Do not retry with another payment. | No |
| `RATE_LIMITED` | Too many requests (HTTP 429). Wait `details.retryAfterMs` before retrying. | Yes |

### API, network and server

| Code | Meaning | Retry |
| --- | --- | --- |
| `NETWORK_ERROR` | The CLI could not reach the API (DNS, TLS, proxy, firewall or offline). The credential was not checked; do not replace the API key. | Yes |
| `TIMEOUT` | The request or query timed out. | Yes |
| `SERVER_ERROR` | The API failed with an internal error (HTTP 5xx). Quote `requestId` to support. | Yes |
| `SERVICE_UNAVAILABLE` | The API or an upstream service is temporarily unavailable (HTTP 503). | Yes |
| `NOT_FOUND` | The resource or endpoint was not found (HTTP 404). | No |
| `TOKEN_NOT_FOUND` | The token was not found (HTTP 404). | No |
| `ADDRESS_NOT_FOUND` | The address has no data (HTTP 404). | No |
| `METHOD_NOT_ALLOWED` | The HTTP method is not allowed for this endpoint (HTTP 405). | No |
| `CONFLICT` | The request conflicts with the current state of the resource (HTTP 409). | No |
| `NON_JSON_RESPONSE` | A trading or limit-order service answered with a body that is not JSON. | Yes |
| `LIMIT_ORDER_NETWORK_ERROR` | The CLI could not reach the limit-order service. | Yes |

### Browser login and saved sessions

| Code | Meaning | Retry |
| --- | --- | --- |
| `AUTH_BUNDLE_TOO_LARGE` | The issued session is larger than secure storage allows. The previous credential is unchanged. | No |
| `AUTH_BUSY` | Another authentication operation is running. Retry after it finishes. | Yes |
| `AUTH_CANCELLED` | The authentication operation was cancelled. | No |
| `AUTH_CLEANUP_REQUIRED` | Old login journals need cleanup. Unlock the credential store and run nansen logout. | No |
| `AUTH_CONNECT_UNAVAILABLE` | The CLI could not connect to the authentication service. | Yes |
| `AUTH_HOME_UNAVAILABLE` | No absolute home directory was found. Set HOME or USERPROFILE. | No |
| `AUTH_JOURNAL_INVALID` | A login recovery journal is corrupt. | No |
| `AUTH_LOCK_UNAVAILABLE` | Native file locking is not available on this platform, so saved authentication cannot be written. | No |
| `AUTH_NETWORK_ERROR` | A network error occurred during browser login. | Yes |
| `AUTH_ORIGIN_MISMATCH` | The saved session or simulation endpoint does not match the selected API origin. | No |
| `AUTH_ORIGIN_UNSUPPORTED` | Browser sessions need the Nansen production or staging API origin. | No |
| `AUTH_SELECTION_CHANGED` | The saved credential changed while the command ran. Retry the command. | Yes |
| `AUTH_STATE_INVALID` | The saved authentication state is invalid. | No |
| `AUTH_STORE_UNAVAILABLE` | The OS credential store is unavailable or locked. | No |
| `AUTH_TIMEOUT` | An authentication operation timed out. | Yes |
| `BROWSER_SESSION_SETUP_REQUIRED` | The session issuer configuration is not compatible with this CLI. | No |
| `INVALID_BROWSER_SESSION` | The API rejected the new browser session. Run nansen login again. | No |
| `PAIRING_CANCELLED` | Browser login was cancelled before approval. | No |
| `PAIRING_DENIED` | Browser login was denied in the browser. | No |
| `PAIRING_EXPIRED` | The browser login code expired before approval. | No |
| `PAIRING_FAILED` | Browser login failed. | No |
| `SESSION_CLOCK_SKEW` | The session is not valid yet because the local clock is behind. Synchronize system time. | No |
| `SESSION_EXPIRED` | The browser access token expired and could not be renewed. Run nansen login. | No |
| `SESSION_REFRESH_PROTOCOL_ERROR` | The issuer rejected the session refresh request format. | No |
| `SESSION_REFRESH_REJECTED` | The saved session cannot be renewed. Run nansen login. | No |
| `SESSION_REFRESH_RETRYABLE` | Session renewal was refused before rotation. Retry later. | Yes |
| `SESSION_REFRESH_RETRY_EXHAUSTED` | Session renewal failed repeatedly. Run nansen login. | No |
| `SESSION_RENEWAL_STORAGE_ERROR` | The renewed session could not be stored. Retry the command. | Yes |
| `SESSION_RENEWAL_UNCERTAIN` | The outcome of session renewal is unknown. Run nansen login. | No |
| `SESSION_VERIFICATION_FAILED` | The CLI could not verify the account of a new browser session. | No |

### Wallets and passwords

| Code | Meaning | Retry |
| --- | --- | --- |
| `NO_WALLET` | No wallet (or WalletConnect session) is available for this chain. | No |
| `INVALID_WALLET` | The wallet cannot sign for this chain or action. | No |
| `PASSWORD_REQUIRED` | The wallet is encrypted and no password was found. `details` lists how to provide one. | No |
| `INCORRECT_PASSWORD` | The wallet password is wrong. | No |
| `NO_PASSWORD_FOUND` | No wallet password was found in any password store. | No |
| `KEYCHAIN_UNAVAILABLE` | The OS keychain is not available for the wallet password. | No |
| `CREATE_FAILED` | The wallet could not be created. | No |
| `DEFAULT_FAILED` | The default wallet could not be changed. | No |
| `DELETE_FAILED` | The wallet could not be deleted. | No |
| `EXPORT_FAILED` | The wallet could not be exported. | No |
| `SHOW_FAILED` | The wallet could not be shown. | No |
| `SEND_FAILED` | A native transfer failed. | No |
| `PRIVY_ERROR` | The Privy wallet service returned an error. | No |

### Trading, quotes and simulation

| Code | Meaning | Retry |
| --- | --- | --- |
| `NO_QUOTES` | No aggregator returned a quote. | No |
| `ALL_QUOTES_FAILED` | Every quote failed to execute. | No |
| `QUOTE_ERROR` | The quote service returned an error. | No |
| `EXECUTE_ERROR` | Trade execution failed. | No |
| `MISSING_QUOTE_ID` | trade execute needs a --quote id. | No |
| `AGGREGATOR_NOT_AVAILABLE` | The requested aggregator has no quote in the saved quote. | No |
| `MAX_INPUT_EXCEEDED` | The quote would spend more than the allowed maximum input. | No |
| `NO_TRANSACTION` | No quote contains transaction data. | No |
| `INVALID_EXECUTION_ROUTE` | The quote has an execution route the CLI does not support. | No |
| `INSUFFICIENT_BALANCE` | The wallet balance is too low for the trade. | No |
| `INSUFFICIENT_GAS` | The wallet has too little native token for gas. | No |
| `WALLET_MISMATCH` | The quote was built for a different wallet. | No |
| `AMOUNT_MISMATCH` | The quote or bridge amount differs from the requested amount. | No |
| `INVALID_SIGNED_TX` | The signed transaction is not valid. | No |
| `BROADCAST_FAILED` | The transaction could not be broadcast. | No |
| `TX_REVERTED` | The transaction reverted on chain. | No |
| `TXHASH_MISMATCH` | The RPC returned a different transaction hash than the one signed. | No |
| `RECEIPT_TIMEOUT` | No transaction receipt arrived in time. Check the transaction before retrying. | No |
| `OUTCOME_VERIFICATION_FAILED` | The CLI could not verify the trade outcome. | No |
| `SWAP_OUTCOME_MISMATCH` | The simulated swap outcome does not match the quote; nothing was signed. | No |
| `LIMIT_ORDER_DESTINATION_MISMATCH` | The limit order sends funds to an unexpected destination; nothing was signed. | No |
| `LIMIT_ORDER_OUTCOME_MISMATCH` | The simulated limit-order deposit does not match the order; nothing was signed. | No |
| `SIMULATION_FAILED` | Pre-broadcast simulation failed; nothing was signed. | No |
| `SIMULATION_ACCESS_DENIED` | The account cannot use hosted simulation. | No |
| `SIM_REVERTED` | The transaction reverts in simulation. | No |
| `SIM_RPC_ERROR` | The simulation RPC returned an error. | No |
| `SIM_RESULT_UNPARSEABLE` | The simulation result could not be parsed. | No |
| `NO_SIM_RPC` | No simulation RPC is configured for the chain. | No |
| `NOT_SIM_CAPABLE` | The RPC does not support simulation. | No |
| `RPC_UNCONFIGURED` | No RPC URL is configured for the chain. | No |
| `RPC_HTTP_ERROR` | The RPC answered with an HTTP or JSON-RPC error. | No |
| `RPC_JSON_ERROR` | The RPC answered with a body that is not JSON. | No |
| `RPC_NETWORK_ERROR` | The CLI could not reach the RPC. | Yes |
| `CONFIRMATION_DECLINED` | The confirmation prompt was declined; nothing was signed. | No |
| `CONFIRMATION_UNAVAILABLE` | Confirmation is required but no terminal is available. Pass --yes to confirm. | No |

### Bridge

| Code | Meaning | Retry |
| --- | --- | --- |
| `BRIDGE_FAILED` | The bridge transfer failed. | No |
| `BRIDGE_NOT_FOUND` | No bridge request was found for the id. | No |
| `BRIDGE_STATUS_ERROR` | The bridge status could not be read. | Yes |
| `BRIDGE_TIMEOUT` | The bridge transfer did not finish in time. Check nansen bridge status. | No |
| `QUOTE_STATE_UNSAFE` | The bridge execution could not be recorded safely. Check nansen bridge status before requesting a new quote. | No |
| `SIGNER_MISMATCH` | The bridge quote expects a different signer. | No |
| `UNEXPECTED_ACTION` | The bridge quote contains an action the CLI does not expect. | No |
| `UNEXPECTED_NETWORK` | The bridge quote uses an unexpected network. | No |
| `PARTIAL_FILL` | The bridge transfer was only partly filled. | No |
| `HL_ACTION_REJECTED` | Hyperliquid rejected the action. | No |

### Perpetuals (Hyperliquid)

| Code | Meaning | Retry |
| --- | --- | --- |
| `BUILDER_FEE_TOO_HIGH` | The builder fee is above the allowed ceiling. | No |
| `BUILDER_FEE_UNAVAILABLE` | The builder fee could not be read or approved. | No |
| `META_UNAVAILABLE` | Hyperliquid asset metadata is not available. | Yes |
| `SANCTIONED` | The address failed sanctions screening. | No |
| `SCREENING_UNAVAILABLE` | Sanctions screening is not available, so the action was refused. | Yes |
| `UNSUPPORTED_NETWORK` | The network is not supported for this perp action. | No |
| `ZERO_PRICE` | The order price rounds to zero. | No |
| `ZERO_SIZE` | The order size rounds to zero. | No |

### Local files, config and tooling

| Code | Meaning | Retry |
| --- | --- | --- |
| `FILE_EXISTS` | The output path already exists; the CLI does not overwrite it. | No |
| `FILE_WRITE_FAILED` | The output file could not be written. | No |
| `LOCAL_FILE_UNSAFE` | A local file has unsafe permissions or type. | No |
| `INVALID_CONFIG` | A configuration file could not be read or parsed. | No |
| `MCP_VERIFY_FAILED` | nansen mcp verify could not connect to the MCP server with the configured settings. | No |
| `UNSUPPORTED_PLATFORM` | The MCP client is not available on this operating system. | No |

### Generic

| Code | Meaning | Retry |
| --- | --- | --- |
| `COMMAND_ERROR` | A command failed without a more specific code. | No |
| `UNKNOWN` | An unexpected error with no code. Report it with the message. | No |

## Field codes

`details.errors[].code` uses the API's field-level codes ([API error handling](https://docs.nansen.ai/getting-started/error-handling)). The CLI uses the same codes for its own checks, so one bad field reads the same from the CLI, the REST API and the MCP server.

| Field code | Meaning |
| --- | --- |
| `missing_field` | A required field or option is missing. |
| `unknown_field` | The field or option is not recognized. The message suggests the closest valid name. |
| `invalid_field_value` | The value is not valid for the field (wrong type, not an allowed value, or a chain the command does not support). |
| `invalid_address_format` | The address does not match the chain's format. |
| `invalid_date_format` | The date is not a valid YYYY-MM-DD date. |
| `invalid_date_range` | The date range is not allowed. |
| `mutually_exclusive_fields` | Two fields that cannot be combined were both given. |
| `value_out_of_range` | The value is outside the allowed range. |
| `too_many_items` | The list has more items than allowed. |
