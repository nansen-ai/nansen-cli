import fs from 'node:fs';
import { NansenError, ErrorCode, packageVersion, telemetryHeaders, sleep } from '../api.js';

const PATH = '/api/v1/feedback';
const TEMPORARY = new Set([429, 500, 502, 503, 504]);
const ERROR_FIELDS = ['error', 'message', 'code', 'status', 'request_id', 'doc_url', 'param', 'reason', 'retry_after', 'quota'];

function required(value, name, usage = 'nansen feedback submit --file feedback.json --submission-id <new-id>') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new NansenError(`${name} is required. Use: ${usage}. Reuse the submission ID and unchanged file after an uncertain submission result.`, ErrorCode.MISSING_PARAM);
  }
  return value;
}

function retryDelay(response, data, attempt, retry) {
  const header = response?.headers.get('retry-after');
  const headerDelay = header && /^\d+(\.\d+)?$/.test(header.trim())
    ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : NaN;
  const advertised = Number.isFinite(headerDelay) ? headerDelay :
    Number.isFinite(data?.retry_after) && data.retry_after >= 0 ? data.retry_after * 1000 : NaN;
  return Math.max(Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt), Number.isFinite(advertised) ? Math.max(0, advertised) : 0);
}

// Feedback keeps the file bytes and uses selected account credentials. It never
// enters the generic client's body cleaning, cache, pagination or payment paths.
async function requestFeedback(api, endpoint, body, submissionId) {
  if (Object.keys(api.defaultHeaders).length) {
    throw new NansenError('Feedback uses account authentication only. Remove --x402-payment-signature.', ErrorCode.INVALID_PARAMS);
  }
  const retry = api.retryOptions;
  const maxRetries = Math.min(retry.maxRetries, 3);
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const credentials = await api.requestCredentials({});
    if (!Object.keys(credentials).length) {
      throw new NansenError('Not logged in. Run: nansen login, or set NANSEN_API_KEY.', ErrorCode.UNAUTHORIZED);
    }
    const secrets = Object.values(credentials).flatMap(value => [value, value.replace(/^Bearer /, '')]);
    const redact = value => {
      if (typeof value === 'string') return secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, value);
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    let response, data;
    try {
      response = await fetch(`${api.baseUrl}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(30000),
        headers: {
          'X-Client-Type': 'nansen-cli', 'X-Client-Version': packageVersion,
          ...telemetryHeaders(), ...credentials,
          ...(body !== undefined && { 'Content-Type': 'application/json', 'Idempotency-Key': submissionId }),
        },
        ...(body !== undefined && { body }),
      });
      data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
      if (response.ok) {
        if (typeof data.feedback_id !== 'string' || typeof data.submission_id !== 'string' ||
            !['received', 'reviewed', 'closed'].includes(data.status) ||
            (submissionId && data.submission_id !== submissionId)) throw new Error('Invalid receipt');
        return redact(data);
      }
    } catch {
      if (response && [402, 404, 501].includes(response.status)) {
        throw new NansenError('Feedback is unavailable on this backend. Retry after feedback support is deployed.', 'feedback_unavailable', response.status,
          { submission_id: submissionId ?? null, request_id: redact(response.headers.get('x-request-id')) });
      }
      const unknown = body !== undefined;
      lastError = new NansenError(
        unknown ? 'The submission may have been saved. Retry the same --submission-id with the unchanged --file.' : 'Receipt lookup failed. Retry nansen feedback get with the same feedback ID.',
        unknown ? 'submission_outcome_unknown' : ErrorCode.NETWORK_ERROR, response?.status ?? null,
        { reason: unknown ? 'submission_outcome_unknown' : 'receipt_unavailable', submission_id: submissionId ?? null, request_id: redact(response?.headers.get('x-request-id') ?? null) },
      );
      if (attempt < maxRetries && (!response || response.ok || TEMPORARY.has(response.status))) {
        const delay = retryDelay(response, null, attempt, retry);
        if (delay <= retry.maxRetryAfterMs) { await sleep(delay); continue; }
      }
      throw lastError;
    }
    const details = redact(Object.fromEntries(ERROR_FIELDS.filter(key => key in data).map(key => [key, data[key]])));
    details.request_id ??= redact(response.headers.get('x-request-id'));
    if (submissionId) details.submission_id = submissionId;
    const unavailable = response.status === 402 || data.code === 'insufficient_credits' || response.status === 501 ||
      (response.status === 404 && (body !== undefined || data.detail === 'Not Found'));
    if (unavailable) {
      throw new NansenError('Feedback is unavailable on this backend. Retry after feedback support is deployed; no payment or account switch was attempted.', 'feedback_unavailable', response.status, details);
    }
    lastError = new NansenError(details.message || 'Feedback request failed.', details.code || ErrorCode.UNKNOWN, response.status, details);
    const weekly = data.reason === 'feedback_weekly_quota_exhausted';
    const delay = retryDelay(response, data, attempt, retry);
    if (!weekly && TEMPORARY.has(response.status) && attempt < maxRetries && delay <= retry.maxRetryAfterMs) {
      await sleep(delay);
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

function receiptText(receipt) {
  const wording = {
    received: 'Received. Your report is saved; human review may still be pending.',
    reviewed: 'Reviewed. A teammate has triaged your report; no fix or date is promised.',
    closed: `Closed. Review is complete. Disposition: ${receipt.disposition ?? 'unspecified'}.`,
  };
  return [wording[receipt.status], `Feedback ID: ${receipt.feedback_id}`, `Submission ID: ${receipt.submission_id}`,
    ...(receipt.replayed ? ['Replay accepted; no new report slot was consumed.'] : []),
    ...(receipt.quota ? [`Weekly allowance: ${receipt.quota.remaining}/${receipt.quota.limit} remaining. Resets: ${receipt.quota.resets_at}`] : [])].join('\n');
}

export function feedbackErrorText(error) {
  const details = error.details ?? {};
  return [error.message, ...(details.quota?.resets_at ? [`Quota resets: ${details.quota.resets_at}`] : []),
    ...(details.retry_after !== undefined ? [`Retry after: ${details.retry_after} seconds`] : []),
    ...(details.submission_id ? [`Submission ID: ${details.submission_id}`] : []),
    ...(details.request_id ? [`Request ID: ${details.request_id}`] : [])].join('\n');
}

export function buildFeedbackCommands({ log = console.log } = {}) {
  return {
    feedback: async (args, api, flags, options) => {
      let receipt;
      if (args[0] === 'submit') {
        const id = required(options['submission-id'], '--submission-id');
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new NansenError('--submission-id must contain 1 to 128 ASCII letters, digits, underscores or hyphens.', ErrorCode.INVALID_PARAMS);
        const file = required(options.file, '--file');
        let body;
        try { body = fs.readFileSync(file, 'utf8'); } catch { throw new NansenError('Cannot read --file. Supply a readable JSON report file.', ErrorCode.INVALID_PARAMS); }
        let report;
        try { report = JSON.parse(body); } catch { throw new NansenError('--file must contain valid JSON.', ErrorCode.INVALID_PARAMS); }
        if (!report || typeof report !== 'object' || Array.isArray(report)) throw new NansenError('--file must contain a JSON report object.', ErrorCode.INVALID_PARAMS);
        receipt = await requestFeedback(api, PATH, body, id);
      } else if (args[0] === 'get') {
        const id = required(args[1], 'Feedback ID', 'nansen feedback get <feedback-id> [--json]');
        if (args.length !== 2) throw new NansenError('Use: nansen feedback get <feedback-id> [--json]', ErrorCode.INVALID_PARAMS);
        receipt = await requestFeedback(api, `${PATH}/${encodeURIComponent(id)}`);
      } else {
        throw new NansenError('Use: nansen feedback submit --file feedback.json --submission-id <new-id>, or nansen feedback get <feedback-id>. Add --json for structured output.', ErrorCode.INVALID_PARAMS);
      }
      if (flags.json || flags.pretty || flags.p) return receipt;
      log(receiptText(receipt));
    },
  };
}
