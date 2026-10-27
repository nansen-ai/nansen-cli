import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { authDirectory } from '../auth-credentials.js';
import { feedbackExpiry, withFeedbackJournal } from '../feedback-journal.js';
import { NansenError, ErrorCode, packageVersion, telemetryHeaders, sleep, statusToErrorCode } from '../api.js';
import { traceError, traceRequest, traceResponse, traceRetry } from '../debug.js';

const PATH = '/api/v1/feedback';
const TEMPORARY = new Set([429, 500, 502, 503, 504]);
const ERROR_FIELDS = ['error', 'message', 'code', 'status', 'request_id', 'doc_url', 'param', 'reason', 'retry_after', 'quota', 'errors'];

function requestId(response) {
  return response?.headers.get('x-request-id') ?? response?.headers.get('x-kong-request-id') ?? null;
}

// Server messages do not always end with a full stop, and CLI guidance follows them.
function sentence(text) {
  const value = String(text).trim();
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function accountAuthOnly(api) {
  if (Object.keys(api.defaultHeaders).length) {
    throw new NansenError('Feedback uses account authentication only. Remove --x402-payment-signature.', ErrorCode.INVALID_PARAMS);
  }
}

function preserveUncertainSubmission(error, pending) {
  return new NansenError(`${sentence(error.message)} ${pending.message}`, pending.code, error.status ?? pending.status,
    { ...error.details, ...pending.details, request_id: error.details?.request_id ?? pending.details.request_id, outcome: 'unknown' });
}

function storageRecoveryError(error, submissionId, unknown = true) {
  return new NansenError(`Private feedback recovery storage is unavailable. ${unknown ? 'The submission may have been saved.' : 'The report was not sent.'} Repair ~/.nansen/feedback, then retry safely with: nansen feedback resume.`,
    error.code, error.status, { ...error.details, submission_id: submissionId, retry_command: 'nansen feedback resume', outcome: unknown ? 'unknown' : 'rejected' });
}

function clearRejectedFeedback(journal, error, submissionId) {
  try { journal.clear(); }
  catch {
    const message = error.code === 'feedback_blocked' ? 'The report was blocked before reaching Nansen. No report was saved.' : error.message;
    throw new NansenError(`${sentence(message)} Local retry data could not be erased. Repair ~/.nansen/feedback, then run: nansen feedback forget before using --new with the corrected --file.`,
      error.code, error.status, { ...error.details, submission_id: submissionId, outcome: 'rejected', retry_command: 'nansen feedback forget' });
  }
}

function required(value, name, usage, hint = '') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new NansenError(`${name} is required. Use: ${usage}.${hint}`, ErrorCode.MISSING_PARAM);
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

function redactor(credentials) {
  const secrets = Object.values(credentials).flatMap(value => [value, value.replace(/^Bearer /, '')]);
  const redact = value => {
    if (typeof value === 'string') return secrets.reduce((text, secret) => secret ? text.split(secret).join('[redacted]') : text, value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  return redact;
}

// Undici quotes a rejected header value in its message, so a malformed key would reach the trace.
function transportFailure(error) {
  const code = error?.cause?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : error?.name ?? 'Error';
}

// Feedback keeps the file bytes and uses selected account credentials. It never
// enters the generic client's body cleaning, cache, pagination or payment paths.
async function requestFeedback(api, endpoint, body, submissionId, { preference = false, previouslyUncertain = false, managed = false } = {}) {
  accountAuthOnly(api);
  const retry = api.retryOptions;
  const maxRetries = Math.min(retry.maxRetries, 3);
  const method = body === undefined ? 'GET' : 'POST', url = `${api.baseUrl}${endpoint}`;
  // A generated ID is recovered with `nansen feedback resume`, which the caller adds.
  const retryHint = managed ? '' : ' Retry the same --submission-id with the unchanged --file.';
  const keepHint = managed ? '' : ' Keep the same --submission-id and unchanged --file for recovery.';
  let lastError;
  let uncertainSubmission = previouslyUncertain ? new NansenError(
    `An earlier attempt may have been saved.${keepHint}`,
    'submission_outcome_unknown', null,
    { reason: 'submission_outcome_unknown', submission_id: submissionId, outcome: 'unknown' },
  ) : undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let credentials;
    try { credentials = await api.requestCredentials({}); } catch (error) {
      if (!uncertainSubmission) throw error;
      throw preserveUncertainSubmission(error, uncertainSubmission);
    }
    if (!Object.keys(credentials).length) {
      throw new NansenError('Not logged in. Run: nansen login, or set NANSEN_API_KEY.', ErrorCode.UNAUTHORIZED);
    }
    const redact = redactor(credentials);
    let response, data;
    api.beforeFeedbackRequest?.();
    const startedAt = Date.now();
    traceRequest({ method, url, attempt: attempt + 1, maxAttempts: maxRetries + 1 });
    try {
      response = await fetch(url, {
        method, redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(30000),
        headers: {
          'X-Client-Type': 'nansen-cli', 'X-Client-Version': packageVersion,
          ...telemetryHeaders(), ...credentials,
          ...(body !== undefined && { 'Content-Type': 'application/json', 'Idempotency-Key': submissionId }),
        },
        ...(body !== undefined && { body }),
      }).catch(error => {
        traceError({ method, url, durationMs: Date.now() - startedAt, attempt: attempt + 1, error: transportFailure(error) });
        throw error;
      });
      traceResponse({ method, url, status: response.status, durationMs: Date.now() - startedAt, requestId: requestId(response), attempt: attempt + 1 });
      data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid response');
      if (response.ok) {
        if (preference) {
          if (!['enabled', 'disabled'].includes(data.automatic_reporting) || typeof data.configured !== 'boolean' ||
              !Number.isSafeInteger(data.version) || data.version < 0 || typeof data.can_manage !== 'boolean' ||
              !(data.updated_at === null || (typeof data.updated_at === 'string' && Number.isFinite(Date.parse(data.updated_at)))) ||
              (!data.configured && data.automatic_reporting !== 'disabled')) throw new Error('Invalid preference');
          return Object.fromEntries(['automatic_reporting', 'configured', 'version', 'updated_at', 'can_manage'].map(key => [key, data[key]]));
        }
        if (typeof data.feedback_id !== 'string' || typeof data.submission_id !== 'string' ||
            !['received', 'reviewed', 'closed'].includes(data.status) ||
            (submissionId && data.submission_id !== submissionId)) throw new Error('Invalid receipt');
        return redact(data);
      }
    } catch {
      if (body !== undefined && response?.status === 403 && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/html') {
        const blocked = new NansenError(uncertainSubmission
          ? 'This attempt was blocked before reaching Nansen.'
          : `The report was blocked before reaching Nansen. No report was saved.${managed ? '' : ' Change the report and use a new submission ID.'}`,
        'feedback_blocked', 403,
        { reason: 'feedback_blocked', outcome: 'rejected', submission_id: submissionId, request_id: redact(requestId(response)) });
        if (uncertainSubmission) throw preserveUncertainSubmission(blocked, uncertainSubmission);
        throw blocked;
      }
      if (response && [402, 404, 501].includes(response.status)) {
        const unavailable = new NansenError('Feedback is unavailable on this backend. Retry after feedback support is deployed.', 'feedback_unavailable', response.status,
          { submission_id: submissionId ?? null, request_id: redact(requestId(response)) });
        if (uncertainSubmission) throw preserveUncertainSubmission(unavailable, uncertainSubmission);
        throw unavailable;
      }
      const unknown = body !== undefined;
      lastError = new NansenError(
        unknown ? `The submission may have been saved.${retryHint}` : preference ? 'Feedback preference unavailable. Show the report and ask before sending.' : 'Receipt lookup failed. Retry nansen feedback get with the same feedback ID.',
        unknown ? 'submission_outcome_unknown' : ErrorCode.NETWORK_ERROR, response?.status ?? null,
        { reason: unknown ? 'submission_outcome_unknown' : preference ? 'preference_unavailable' : 'receipt_unavailable', submission_id: submissionId ?? null, request_id: redact(requestId(response)), ...(unknown && { outcome: 'unknown' }) },
      );
      if (unknown) uncertainSubmission = lastError;
      if (attempt < maxRetries && (!response || response.ok || TEMPORARY.has(response.status))) {
        const delay = retryDelay(response, null, attempt, retry);
        if (delay <= retry.maxRetryAfterMs) {
          traceRetry({ method, url, status: response?.status, attempt: attempt + 1, reason: response ? 'unparseable-response' : 'network-error', delayMs: delay });
          await sleep(delay); continue;
        }
      }
      throw lastError;
    }
    const details = redact(Object.fromEntries(ERROR_FIELDS.filter(key => key in data).map(key => [key, data[key]])));
    details.request_id ??= redact(requestId(response));
    if (submissionId) details.submission_id = submissionId;
    if (uncertainSubmission && data.reason !== 'feedback_erased') details.outcome = 'unknown';
    if (response.status === 403 && data.reason === 'feedback_not_enabled') {
      const uncertainty = uncertainSubmission ? ` An earlier attempt may have been saved.${keepHint}` : '';
      throw new NansenError(`Feedback is not enabled for this account. Stop automatic retries. User approval or an enabled preference does not override rollout.${uncertainty}`,
        uncertainSubmission ? uncertainSubmission.code : details.code || 'forbidden', response.status,
        { ...details, outcome: uncertainSubmission ? 'unknown' : 'rejected' });
    }
    const unavailable = response.status === 402 || data.code === 'insufficient_credits' || response.status === 501 ||
      (response.status === 404 && body !== undefined);
    if (unavailable) {
      const error = new NansenError('Feedback is unavailable on this backend. Retry after feedback support is deployed; no payment or account switch was attempted.', 'feedback_unavailable', response.status, details);
      if (uncertainSubmission) throw preserveUncertainSubmission(error, uncertainSubmission);
      throw error;
    }
    if (response.status === 404) {
      if (preference) throw new NansenError('Feedback preference unavailable on this backend. Show the report and ask before sending.', 'feedback_unavailable', response.status, details);
      throw new NansenError('Receipt not found, or this backend does not support feedback yet. Check the feedback ID, active account and NANSEN_BASE_URL. Do not resubmit as a new report.', details.code || 'not_found', response.status, details);
    }
    lastError = new NansenError(details.message || 'Feedback request failed.', details.code || statusToErrorCode(response.status, data), response.status, details);
    if (body !== undefined && response.status >= 500 && data.reason !== 'feedback_admissions_paused') {
      uncertainSubmission ??= new NansenError(`The submission may have been saved.${retryHint}`,
        'submission_outcome_unknown', response.status,
        { reason: 'submission_outcome_unknown', submission_id: submissionId, request_id: details.request_id });
    }
    if (uncertainSubmission && [401, 403].includes(response.status)) throw preserveUncertainSubmission(lastError, uncertainSubmission);
    const weekly = data.reason === 'feedback_weekly_quota_exhausted';
    const delay = retryDelay(response, data, attempt, retry);
    if (!weekly && TEMPORARY.has(response.status) && attempt < maxRetries && delay <= retry.maxRetryAfterMs) {
      traceRetry({ method, url, status: response.status, attempt: attempt + 1, reason: 'retryable-status', delayMs: delay });
      await sleep(delay);
      continue;
    }
    if (uncertainSubmission && response.status >= 500) {
      throw new NansenError(`${sentence(lastError.message)} ${uncertainSubmission.message}`, uncertainSubmission.code,
        response.status, { ...details, outcome: 'unknown' });
    }
    throw lastError;
  }
  throw lastError;
}

// Resolve the account from the server, then freeze those exact credentials for
// the entire operation. Re-login in another process cannot redirect a replay.
async function feedbackIdentity(api) {
  accountAuthOnly(api);
  const credentials = await api.requestCredentials({});
  if (!Object.keys(credentials).length) throw new NansenError('Not logged in. Run: nansen login, or set NANSEN_API_KEY.', ErrorCode.UNAUTHORIZED);
  let response, data;
  try {
    const environment = new URL(api.baseUrl).href.replace(/\/$/, '');
    const url = `${environment}/api/v1/account`, startedAt = Date.now();
    traceRequest({ method: 'GET', url, attempt: 1 });
    response = await fetch(url, { headers: credentials, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) }).catch(error => {
      traceError({ method: 'GET', url, durationMs: Date.now() - startedAt, attempt: 1, error: transportFailure(error) });
      throw error;
    });
    traceResponse({ method: 'GET', url, status: response.status, durationMs: Date.now() - startedAt, requestId: requestId(response), attempt: 1 });
    data = await response.json();
    if (!response.ok || typeof data.user_id !== 'string' || !data.user_id || data.user_id.length > 255 || [...data.user_id].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error();
    return { account: data.user_id, environment, api: { ...api, baseUrl: environment, requestCredentials: async () => credentials } };
  } catch {
    // A rejected credential is not an account or environment change. An HTML 403 is an edge block, not a key problem.
    if (response?.status === 401 || (response?.status === 403 && typeof data?.message === 'string')) {
      const redact = redactor(credentials);
      const reason = typeof data?.message === 'string' && data.message.trim() ? redact(data.message) : `HTTP ${response.status}`;
      // Any key may read the account, so a JSON 403 refuses the account itself and another key would not help.
      const next = response.status === 401 ? 'Use a valid API key or login for the original account, then retry.' : "Check this account's access, then retry.";
      throw new NansenError(`${sentence(reason)} Could not verify the feedback account. No report was sent. ${next}`,
        'feedback_identity_unverified', response.status, { request_id: redact(requestId(response)) });
    }
    throw new NansenError('Could not verify the feedback account. No report was sent. Retry with the original account and NANSEN_BASE_URL.', 'feedback_identity_unverified');
  }
}

async function managedFeedback(api, { body, newSubmission = false, forget = false } = {}) {
  return withFeedbackJournal(async journal => {
    let entry = journal.entry;
    if (forget) { journal.clear(); return { forgotten: true }; }
    if (newSubmission && entry?.state === 'pending') throw new NansenError('A submission is still pending. Run: nansen feedback resume. To erase its local retry data, run: nansen feedback forget.', 'feedback_pending');
    if ((!entry && body === undefined) || (entry?.state === 'cleared' && !newSubmission)) throw new NansenError('No replayable feedback remains. Expired or erased submissions are never replayed. Use --new only for a deliberate new report.', 'feedback_recovery_unavailable');
    if (entry?.state === 'confirmed' && body !== undefined && !newSubmission) throw new NansenError('The previous submission has a confirmed receipt. Run: nansen feedback resume. Use --new only for a deliberate new report.', 'feedback_already_confirmed');
    if (entry && !newSubmission && new URL(api.baseUrl).href.replace(/\/$/, '') !== entry.environment) throw new NansenError('The API environment changed. Restore the original NANSEN_BASE_URL, then run: nansen feedback resume.', 'feedback_identity_mismatch');
    if (entry?.state === 'pending' && body !== undefined && body !== entry.body) throw new NansenError('The report changed. Run: nansen feedback resume to retry the saved, unchanged report, or nansen feedback forget to erase its local retry data before a deliberate --new submission.', 'feedback_report_changed');
    const identity = await feedbackIdentity(api);
    if (entry && !newSubmission && identity.account !== entry.account) throw new NansenError('The Nansen account changed. Log in to the original account, then run: nansen feedback resume.', 'feedback_identity_mismatch');
    if (!entry || newSubmission) {
      entry = { version: 1, state: 'pending', submission_id: randomUUID(), account: identity.account, environment: identity.environment, expires_at: feedbackExpiry(Date.now()), body, uncertain: false };
      try { journal.save(entry); }
      catch (error) {
        // The journal may already exist even if its directory sync failed.
        if (error.journalSaved) throw storageRecoveryError(error, entry.submission_id, false);
        throw error;
      }
    }
    // Older journals cannot distinguish a denial from a lost response.
    const previouslyUncertain = entry.state === 'pending' && entry.uncertain !== false;
    let dispatched = false;
    identity.api.beforeFeedbackRequest = () => {
      if (Date.parse(entry.expires_at) <= Date.now()) {
        journal.clear();
        throw new NansenError('Saved feedback expired and was erased. It will not be replayed.', 'feedback_recovery_unavailable');
      }
      if (entry.state === 'pending' && !dispatched) {
        // A crash after dispatch must never turn a possible acceptance into a rejection.
        journal.save({ ...entry, uncertain: true });
        dispatched = true;
      }
    };
    try {
      const receipt = entry.state === 'confirmed'
        ? await requestFeedback(identity.api, `${PATH}/${encodeURIComponent(entry.feedback_id)}`, undefined, entry.submission_id)
        : await requestFeedback(identity.api, PATH, entry.body, entry.submission_id, { previouslyUncertain, managed: true });
      const expiry = Date.parse(receipt.expires_at);
      if (!Number.isFinite(expiry)) throw new NansenError('The receipt expiry could not be confirmed. The submission may have been saved.', 'submission_outcome_unknown');
      // Never retain the body, its digest, or any free-text receipt fields.
      journal.save({ version: 1, state: 'confirmed', submission_id: entry.submission_id, account: entry.account, environment: entry.environment,
        expires_at: new Date(Math.min(expiry, Date.parse(entry.expires_at))).toISOString(), feedback_id: receipt.feedback_id });
      return receipt;
    } catch (error) {
      if (error.details?.reason === 'feedback_erased') { clearRejectedFeedback(journal, error, entry.submission_id); throw error; }
      if (entry.state === 'confirmed' && error.status === 404) {
        try { journal.clear(); } catch (storageError) { throw storageRecoveryError(storageError, entry.submission_id); }
        throw error;
      }
      if (entry.state !== 'pending' || error.code === 'feedback_recovery_unavailable') throw error;
      if (error.code === 'feedback_storage_unavailable') throw storageRecoveryError(error, entry.submission_id, dispatched || previouslyUncertain);
      const unknown = previouslyUncertain || error.code === 'submission_outcome_unknown' || error.details?.outcome === 'unknown';
      if (!unknown && ([400, 413, 422].includes(error.status) || (error.status === 409 && error.details?.reason === 'idempotency_key_reused') ||
          error.code === 'feedback_blocked')) {
        clearRejectedFeedback(journal, error, entry.submission_id);
        throw new NansenError(`${sentence(error.message)} This attempt was rejected. Local retry data was erased. Correct the report and use --new with the corrected --file.`,
          error.code, error.status, { ...error.details, submission_id: entry.submission_id, outcome: 'rejected' });
      }
      try { journal.save({ ...entry, uncertain: unknown }); }
      catch (error) { throw storageRecoveryError(error, entry.submission_id, dispatched || previouslyUncertain); }
      if (error.status === 403 && error.details?.reason === 'feedback_not_enabled') {
        const outcomeText = unknown ? '' : ' This report was not accepted.';
        throw new NansenError(`${error.message}${outcomeText} The saved ID and report are retained for recovery.`,
          error.code, error.status, { ...error.details, submission_id: entry.submission_id, outcome: unknown ? 'unknown' : 'rejected' });
      }
      if (error.status === 429 && error.details?.reason === 'feedback_weekly_quota_exhausted') {
        throw new NansenError(`${sentence(error.message)} ${unknown ? 'An earlier attempt may have been accepted.' : 'This submission was not accepted.'} Wait for the weekly reset before running: nansen feedback resume.`,
          error.code, error.status, { ...error.details, submission_id: entry.submission_id, outcome: unknown ? 'unknown' : 'rejected',
            retry_command: 'nansen feedback resume', retry_not_before: error.details.quota?.resets_at ?? null });
      }
      // submission_outcome_unknown messages already say the submission may have been saved.
      const recovery = unknown
        ? `${error.code === 'submission_outcome_unknown' ? '' : 'The saved submission may have been accepted. '}Retry safely with: nansen feedback resume.`
        : 'This report was not accepted. Retry the saved report with: nansen feedback resume.';
      throw new NansenError(`${sentence(error.message)} ${recovery}`,
        error.code, error.status, { ...error.details, submission_id: entry.submission_id, retry_command: 'nansen feedback resume', outcome: unknown ? 'unknown' : 'rejected' });
    }
  }, { erase: forget });
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
    ...(Array.isArray(details.errors) ? details.errors.filter(item => typeof item?.field === 'string' && typeof item.code === 'string')
      .map(item => `${item.field}: ${item.code}`) : []),
    ...(details.retry_after !== undefined ? [`Retry after: ${details.retry_after} seconds`] : []),
    ...(details.submission_id ? [`Submission ID: ${details.submission_id}`] : []),
    ...(details.request_id ? [`Request ID: ${details.request_id}`] : [])].join('\n');
}

export function buildFeedbackCommands({ log = console.log } = {}) {
  return {
    feedback: async (args, api, flags, options) => {
      let receipt;
      if (flags['submission-id']) throw new NansenError('--submission-id requires a value.', ErrorCode.INVALID_PARAMS);
      if (args[0] === 'preferences') {
        if (args.length !== 1 || options.file || options['submission-id'] || flags.new) throw new NansenError('Use: nansen feedback preferences [--json]', ErrorCode.INVALID_PARAMS);
        accountAuthOnly(api);
        try { receipt = await requestFeedback(api, `${PATH}/preferences`, undefined, undefined, { preference: true }); }
        catch (error) {
          const guidance = 'Feedback preference unavailable. Show the report and ask before sending.';
          // Local failures and rejected credentials tell the user what to fix; other HTTP failures only need the guidance.
          const cause = (error.status == null || [401, 403].includes(error.status)) && error.message !== guidance ? ` ${error.message}` : '';
          throw new NansenError(`${guidance}${cause}`, error.code, error.status,
            { ...error.details, reason: 'preference_unavailable' });
        }
        if (flags.json || flags.pretty || flags.p) return receipt;
        log(`Automatic feedback: ${receipt.automatic_reporting}${receipt.configured ? '' : ' (not configured)'}.\n${receipt.automatic_reporting === 'enabled' ? 'Agents may send without asking, subject to host controls and account rollout.' : 'Show the report and ask before sending.'}\nChange the lasting choice in Superapp settings. Approval for one report does not change it.`);
        return;
      } else if (args[0] === 'submit') {
        if (args.length !== 1) throw new NansenError('Use: nansen feedback submit --file feedback.json [--submission-id <new-id> | --new] [--json]', ErrorCode.INVALID_PARAMS);
        const id = options['submission-id'];
        if (id !== undefined && flags.new) throw new NansenError('Use either --new or --submission-id.', ErrorCode.INVALID_PARAMS);
        if (id !== undefined && (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new NansenError('--submission-id must contain 1 to 128 ASCII letters, digits, underscores or hyphens.', ErrorCode.INVALID_PARAMS);
        const file = required(options.file, '--file', 'nansen feedback submit --file feedback.json --submission-id <new-id>',
          ' Reuse the submission ID and unchanged file after an uncertain submission result.');
        let body;
        try { body = fs.readFileSync(file, 'utf8'); } catch { throw new NansenError('Cannot read --file. Supply a readable JSON report file.', ErrorCode.INVALID_PARAMS); }
        let report;
        try { report = JSON.parse(body); } catch { throw new NansenError('--file must contain valid JSON.', ErrorCode.INVALID_PARAMS); }
        if (!report || typeof report !== 'object' || Array.isArray(report)) throw new NansenError('--file must contain a JSON report object.', ErrorCode.INVALID_PARAMS);
        if (Buffer.byteLength(body) > 16384) throw new NansenError('The report exceeds 16 KiB.', ErrorCode.INVALID_PARAMS);
        receipt = id !== undefined ? await requestFeedback(api, PATH, body, id) : await managedFeedback(api, { body, newSubmission: flags.new === true });
      } else if (args[0] === 'resume' || args[0] === 'forget') {
        if (args.length !== 1 || options.file || options['submission-id'] || flags.new) throw new NansenError(`Use: nansen feedback ${args[0]} [--json]`, ErrorCode.INVALID_PARAMS);
        receipt = await managedFeedback(api, { forget: args[0] === 'forget' });
      } else if (args[0] === 'get') {
        const id = required(args[1], 'Feedback ID', 'nansen feedback get <feedback-id> [--json]');
        if (args.length !== 2) throw new NansenError('Use: nansen feedback get <feedback-id> [--json]', ErrorCode.INVALID_PARAMS);
        const local = path.join(authDirectory(), 'feedback', 'recovery.json');
        if (fs.lstatSync(local, { throwIfNoEntry: false })) {
          receipt = await withFeedbackJournal(async journal => {
            if (journal.entry?.state !== 'confirmed' || journal.entry.feedback_id !== id) return requestFeedback(api, `${PATH}/${encodeURIComponent(id)}`);
            const identity = await feedbackIdentity(api);
            if (identity.account !== journal.entry.account || identity.environment !== journal.entry.environment) throw new NansenError('Use the original account and NANSEN_BASE_URL to read the saved receipt.', 'feedback_identity_mismatch');
            try { return await requestFeedback(identity.api, `${PATH}/${encodeURIComponent(id)}`, undefined, journal.entry.submission_id); }
            catch (error) {
              if (error.status === 404 || error.details?.reason === 'feedback_erased') {
                try { journal.clear(); } catch (storageError) { throw storageRecoveryError(storageError, journal.entry.submission_id); }
              }
              throw error;
            }
          });
        } else receipt = await requestFeedback(api, `${PATH}/${encodeURIComponent(id)}`);
      } else {
        throw new NansenError('Use: nansen feedback preferences, nansen feedback submit --file feedback.json, nansen feedback resume, nansen feedback forget, or nansen feedback get <feedback-id>. Add --json for structured output.', ErrorCode.INVALID_PARAMS);
      }
      if (flags.json || flags.pretty || flags.p) return receipt;
      log(receipt.forgotten ? 'Local feedback retry data erased. This does not delete a report already saved by Nansen. Your original input file is unchanged.' : receiptText(receipt));
    },
  };
}
