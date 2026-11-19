/**
 * Nansen CLI — direct Hyperliquid exchange submission (client egress).
 *
 * This is the ONE direct-to-HL network call (Decision D4): a signed L1 or
 * user-signed action goes straight from the user's machine to
 * api.hyperliquid.xyz/exchange. Reads and market-data stay on the Nansen proxy
 * (/api/v1/perp/*), so nothing else here talks to HL directly.
 *
 * Mirrors the contract of the backend proxy (perp_execute.py) that this
 * replaces. HL replies with an envelope:
 *   { status: "ok" | "err", response: <object|string> }
 * and signals failure in TWO ways, both of which must throw:
 *   1. a top-level status of "err" (response carries the reason string), and
 *   2. a status of "ok" that still carries per-action errors in
 *      response.data.statuses[].error — a rejected order that would otherwise
 *      masquerade as a fill. The proxy caught this via extract_action_errors;
 *      going direct, the CLI has to catch it itself.
 */

import { CommandError, transportFailure } from "./api.js";
// The base URL and network live in hl-env.js so hl-action.js can resolve the
// network without importing this module (it builds actions; this one submits
// them). Re-exported here because this is where callers expect to find them.
export {
  HL_MAINNET_API_URL,
  HL_TESTNET_API_URL,
  hlApiUrl,
  hlNetwork,
} from "./hl-env.js";

import { hlApiUrl } from "./hl-env.js";

// Transport failures that happen before a connection exists (the host name did
// not resolve, or the connection was refused), so the signed action never left
// this machine. Any other failure, such as a reset or a closed socket, can
// happen after Hyperliquid has read the whole request and applied it.
const NOT_SENT_FAILURES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);

// What to do when the outcome of a submitted action is unknown.
const RECONCILE_ADVICE =
  'the action may or may not have been applied. Check "nansen perp orders" and "nansen perp positions" before retrying.';

function exchangeError(message, code, exchangeResult) {
  const error = new CommandError(message, code);
  // Keep only a structured action response available to the caller so it can
  // emit authoritative per-leg outcomes before rethrowing. Opaque HTTP bodies
  // are not action results and must remain indeterminate.
  if (exchangeResult !== undefined) error.exchangeResult = exchangeResult;
  return error;
}

// Port of perp_execute.py::extract_action_errors. HL returns top-level
// status "ok" even when individual actions are rejected:
//   {"status":"ok","response":{"data":{"statuses":[{"error":"..."}]}}}
// Split every returned leg so a partial TP/SL cannot be reported as either a
// total success or a total failure.
export function extractActionErrors(responseBody, action) {
  const result = { succeeded: [], failed: [] };
  if (!responseBody || typeof responseBody !== "object") return result;
  const data = responseBody.data;
  if (!data || typeof data !== "object") return result;
  const statuses = data.statuses;
  if (!Array.isArray(statuses)) return result;
  for (const [index, entry] of statuses.entries()) {
    const tpsl = action?.orders?.[index]?.t?.trigger?.tpsl;
    const leg = tpsl === "tp"
      ? "take-profit"
      : tpsl === "sl"
        ? "stop-loss"
        : action?.grouping === "normalTpsl" && index === 0
          ? "parent"
          : `leg ${index + 1}`;
    if (entry && typeof entry === "object" && "error" in entry) {
      result.failed.push({ leg, error: String(entry.error) });
    } else {
      result.succeeded.push(leg);
    }
  }
  return result;
}

// POST a signed action to HL's /exchange endpoint.
//
// `signature` is the {r, s, v} object signAgent() already produces; `nonce` is
// the same nonce the action was hashed with; `vaultAddress` is null for a normal
// wallet (omitted from the body when null, matching the SDK).
//
// Returns the parsed HL response object on success. Throws CommandError on a
// network failure, a non-JSON / HTTP-error response, a top-level "err", or a
// per-action error.
//
// Deliberately NOT retried: each submit carries a unique nonce and is not
// idempotent, so a retry after a request that may have reached HL risks a
// double-submit. A transport failure is HL_NETWORK_ERROR only when the
// connection was never made; any other is HL_TIMEOUT_INDETERMINATE.
export async function submitExchange(
  { action, nonce, signature, vaultAddress = null },
  { fetchImpl = fetch, baseUrl = hlApiUrl(), timeoutMs = 30000 } = {}
) {
  const body = { action, nonce, signature };
  // HL only expects vaultAddress when trading on behalf of a vault; omit the
  // null so a normal-wallet action hashes/serializes like the SDK's.
  if (vaultAddress != null) body.vaultAddress = vaultAddress;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // A timeout on a POST is indeterminate: the request may have reached
    // Hyperliquid and been applied even though the response never arrived.
    // Say so rather than implying nothing was sent, and point at the reads that
    // resolve it.
    if (err.name === "AbortError") {
      throw new CommandError(
        `Timed out after ${timeoutMs}ms waiting for Hyperliquid. The request may still have been received — ${RECONCILE_ADVICE}`,
        "HL_TIMEOUT_INDETERMINATE"
      );
    }
    // Only a failure that proves nothing was sent is reported as "could not
    // reach". A connection lost after the request went out is as indeterminate
    // as a timeout: the order may be live, and a retry would place it twice.
    const reason = transportFailure(err);
    if (NOT_SENT_FAILURES.has(reason)) {
      throw new CommandError(
        `Could not reach Hyperliquid (${reason}); the action was not sent. Check your connection and retry.`,
        "HL_NETWORK_ERROR"
      );
    }
    throw new CommandError(
      `The connection to Hyperliquid failed (${reason}). The request may have been received — ${RECONCILE_ADVICE}`,
      "HL_TIMEOUT_INDETERMINATE"
    );
  } finally {
    clearTimeout(timer);
  }

  // The response headers arrived, so Hyperliquid has the request. A connection
  // lost while the body is read leaves the outcome just as unknown.
  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw new CommandError(
      `The connection to Hyperliquid failed (${transportFailure(err)}) while its response was read. The request was received — ${RECONCILE_ADVICE}`,
      "HL_TIMEOUT_INDETERMINATE"
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CommandError(
      `Hyperliquid returned a non-JSON response (HTTP ${
        response.status
      }): ${text.slice(0, 200)}`,
      "HL_BAD_RESPONSE"
    );
  }

  if (!response.ok) {
    const detail =
      typeof data === "string"
        ? data
        : data.response || data.error || JSON.stringify(data);
    throw exchangeError(
      `Hyperliquid error (HTTP ${response.status}): ${detail}`,
      "HL_HTTP_ERROR",
    );
  }

  const status = data.status ?? "ok";
  const responseBody = data.response;

  if (status === "err") {
    const reason =
      typeof responseBody === "string"
        ? responseBody
        : "Hyperliquid rejected the action";
    throw exchangeError(
      `Hyperliquid rejected the action: ${reason}`,
      "HL_ACTION_REJECTED",
      data,
    );
  }

  const actionResults = extractActionErrors(responseBody, action);
  if (actionResults.failed.length > 0 && actionResults.succeeded.length > 0) {
    throw exchangeError(
      `Hyperliquid partially filled the action: succeeded ${actionResults.succeeded.join(", ")}; failed ${actionResults.failed.map(({ leg, error }) => `${leg}: ${error}`).join("; ")}`,
      "PARTIAL_FILL",
      data,
    );
  }
  if (actionResults.failed.length > 0) {
    throw exchangeError(
      `Hyperliquid rejected the action: ${actionResults.failed.map(({ error }) => error).join("; ")}`,
      "HL_ACTION_REJECTED",
      data,
    );
  }

  return data;
}
