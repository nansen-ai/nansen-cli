import { AuthError, authConfigView } from './auth-credentials.js';
import { createAuthState } from './auth-state.js';
import { createDeviceClient, pairDevice, retireSession } from './auth-device.js';
import { openAuthBrowser } from './auth-browser.js';

export function defaultAuthState() { return createAuthState({ retire: retireSession }); }
export function cleanupMessage(results = []) {
  const messages = [];
  if (results.some(r => r.code === 'AUTH_JOURNAL_INVALID')) messages.push('Authentication recovery cannot safely read auth-operations. Preserve its files and secure-store entries; see docs/browser-login.md#damaged-or-unrecognized-journals before retrying cleanup.');
  if (results.some(r => r.code === 'AUTH_STATE_INVALID')) messages.push('Saved authentication and recovery metadata disagree. Preserve config.json, auth-operations and secure-store entries; contact the session operator before retrying cleanup.');
  if (results.some(r => r.local === 'unrecognized')) messages.push('Unrecognized JSON files remain in auth-operations. They were preserved and not treated as credential journals. See docs/browser-login.md#damaged-or-unrecognized-journals.');
  if (results.some(r => r.local === 'incomplete' && !['AUTH_JOURNAL_INVALID', 'AUTH_STATE_INVALID'].includes(r.code))) messages.push('Secure-store deletion incomplete. Unlock the credential store and run nansen logout to finish cleanup.');
  if (results.some(r => r.local === 'pending')) messages.push('Authentication cleanup remains pending. After other login attempts finish and the credential store is unlocked, rerun nansen logout to process the next bounded batch.');
  if (results.some(r => r.remote === 'unconfirmed')) messages.push('Remote revocation unconfirmed. Contact the session/revocation operator to revoke the affected session; local deselection does not confirm remote invalidation.');
  if (results.some(r => r.remote === 'recorded_pending')) messages.push('Family revocation recorded; API propagation is pending.');
  if (results.some(r => r.remote === 'refresh_only')) messages.push('Refresh family retired; issued access tokens may remain valid until expiry.');
  return messages;
}
export async function browserLogin({ flags = {}, env = process.env, isTTY = process.stdout.isTTY, log = console.log, errorOutput = console.error, state = defaultAuthState(), clientFactory = createDeviceClient, pair = pairDevice, retire = retireSession, openBrowser = openAuthBrowser, signals = process } = {}) {
  const machine = flags.json || !isTTY;
  const emit = (event, data) => { if (machine) log(JSON.stringify({ version: 1, event, ...data })); };
  const progress = machine ? errorOutput : log;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signals.on('SIGINT', cancel); signals.on('SIGTERM', cancel);
  let attempt;
  let candidate;
  let saved = false;
  let cleanup = [];
  try {
    const view = authConfigView(env);
    const audience = view.baseUrl;
    // Origin validation and native preflight both precede any approval request.
    let client;
    try { client = clientFactory({ audience }); }
    catch (error) {
      if (error.code === 'AUTH_ORIGIN_UNSUPPORTED') throw new AuthError(error.code, `Browser sessions require the Nansen production or staging API origin. Correct ${view.baseUrlSource === 'env' ? 'NANSEN_BASE_URL' : 'baseUrl in config.json'}; plain login preserves the selected origin.`);
      throw error;
    }
    attempt = await state.begin({ signal: controller.signal });
    cleanup.push(...attempt.cleanup);
    const bundle = await pair(client, {
      signal: controller.signal,
      onBeforePoll: () => state.markIssuancePossible(attempt, controller.signal),
      onIssued: value => { candidate = value; attempt.journal.unissued = false; },
      onPending: async pending => {
        emit('pending', pending);
        progress(`Approve nansen CLI in your browser: ${pending.verification_uri}\nCode: ${pending.user_code}`);
        if (!flags['no-browser'] && !await openBrowser(pending.verification_uri, audience)) progress('Could not open a browser. Open the displayed link on a trusted device.');
      },
    });
    const result = await state.install(attempt, { bundle, baseUrl: audience }, controller.signal);
    saved = true;
    cleanup.push(...result.cleanup);
    try { cleanup.push(...await state.finish(attempt)); } catch { cleanup.push({ local: 'incomplete', remote: 'unconfirmed' }); }
    attempt = null;
    const override = env.NANSEN_API_KEY !== undefined;
    const overrideMessage = override && !env.NANSEN_API_KEY.trim()
      ? 'NANSEN_API_KEY is blank. Commands will fail until you unset it or supply a valid environment key.'
      : 'Commands still use NANSEN_API_KEY. Unset it to use this session.';
    progress(override ? `Browser session saved for ${bundle.accountId}. ${overrideMessage}` : `Browser session saved for ${bundle.accountId}.`);
    for (const message of cleanupMessage(cleanup)) progress(message);
    emit('saved', { account_id: bundle.accountId, effective_source: override ? 'env' : 'session', cleanup });
  } catch (error) {
    // A pointer commit is authoritative even if acknowledgement/cleanup failed.
    saved ||= attempt?.committed === true;
    if (!saved && attempt && !attempt.uncertain && candidate) {
      const result = await retire(candidate);
      attempt.journal.candidateRemote = result.remote;
    } else if (attempt && error.provenUnissued === true) attempt.journal.unissued = true;
    if (attempt) {
      try { cleanup.push(...await state.finish(attempt)); } catch { cleanup.push({ local: 'incomplete', remote: 'unconfirmed' }); }
      attempt = null;
    }
    if (saved) {
      progress('Browser session saved; cleanup is incomplete. Run nansen auth status.');
      emit('saved', { cleanup, cleanup_incomplete: true });
      return;
    }
    const cancelled = controller.signal.aborted;
    const safe = error instanceof AuthError ? error : new AuthError('PAIRING_FAILED', 'Could not save browser authentication. The previous selection is unchanged. Retry after checking storage and connectivity.');
    if (cancelled) { safe.code = 'PAIRING_CANCELLED'; safe.message = 'Login cancelled. The previous saved credential is unchanged.'; }
    for (const message of cleanupMessage(cleanup)) progress(message);
    if (machine) { emit(cancelled ? 'cancelled' : 'error', { code: safe.code, message: safe.message, cleanup }); safe.reported = true; }
    throw safe;
  } finally {
    signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel);
    if (attempt) await state.finish(attempt);
  }
}
