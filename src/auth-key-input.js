import { CommandError } from './api.js';

const MAX_KEY_BYTES = 4096;

function inputError(message, code) {
  return new CommandError(message, code, { error: code, message });
}

/**
 * Read a single secret from a pipe or redirected file. Shared by the API key
 * (`--api-key-stdin`) and the alert webhook signing secret
 * (`--webhook-secret-stdin`). `errors` maps each failure to the
 * CommandError to throw; none of them may quote the input.
 */
async function readSecretBytes(input, isTTY, { timeoutMs, maxBytes, errors }) {
  if (isTTY) throw errors.notAPipe();
  const chunks = [];
  let size = 0;
  const timeoutError = errors.timeout();
  let timer;
  let iterator;
  let exhausted = false;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError), timeoutMs); });
  try {
    iterator = input[Symbol.asyncIterator]();
    while (true) {
      const { done, value } = await Promise.race([iterator.next(), timeout]);
      if (done) { exhausted = true; break; }
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += bytes.length;
      if (size > maxBytes) break;
      chunks.push(bytes);
    }
  } catch (error) {
    if (error === timeoutError) throw timeoutError;
    throw errors.failed();
  } finally {
    clearTimeout(timer);
    try { input.destroy?.(); } catch { /* Never expose input cleanup errors. */ }
    // A pending next() can keep return() pending too. Request finalization,
    // but never let a custom iterator extend the input deadline.
    if (!exhausted) {
      try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch { /* Preserve the sanitized input error. */ }
    }
  }
  if (size > maxBytes) throw errors.tooLarge();
  return Buffer.concat(chunks).toString('utf8');
}

function hasControlChars(value) {
  return /�/u.test(value) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

// Explicit stdin input keeps secrets out of command arguments and shell history.
export async function readApiKeyInput(input, isTTY = input.isTTY, { timeoutMs = 30_000 } = {}) {
  const raw = await readSecretBytes(input, isTTY, {
    timeoutMs,
    maxBytes: MAX_KEY_BYTES,
    errors: {
      notAPipe: () => inputError('Pipe an API key or redirect a key file into --api-key-stdin. For a hidden terminal prompt, use nansen login --human.', 'NOT_A_PIPE'),
      timeout: () => inputError('Timed out reading the API key from stdin. Close the pipe after writing a single key, or redirect a key file.', 'API_KEY_INPUT_TIMEOUT'),
      failed: () => inputError('Could not read the API key from stdin. Check the input and try again.', 'API_KEY_INPUT_FAILED'),
      tooLarge: () => inputError('API key input exceeds 4096 bytes. Provide a single API key.', 'INVALID_PARAMS'),
    },
  });
  const key = raw.trim();
  if (!key) throw inputError('No API key received on stdin. Pipe a single key or redirect a key file.', 'API_KEY_REQUIRED');
  if (/\s/u.test(key) || hasControlChars(key)) throw inputError('API key input must contain a single key without whitespace or control characters.', 'INVALID_PARAMS');
  return key;
}

/**
 * Read an alert webhook signing secret from stdin (`--webhook-secret-stdin`).
 * Surrounding whitespace (such as the newline `echo` adds) is removed, so the
 * secret matches what a listener reads from a trimmed env var or file. Inner
 * spaces are kept; line breaks and other control characters are rejected
 * because they mean more than one value was piped.
 */
export async function readWebhookSecretInput(input, isTTY = input?.isTTY, { timeoutMs = 30_000 } = {}) {
  const raw = await readSecretBytes(input, isTTY, {
    timeoutMs,
    maxBytes: MAX_KEY_BYTES,
    errors: {
      notAPipe: () => inputError('--webhook-secret-stdin reads from a pipe or redirected file, not a terminal. Example: nansen alerts create ... --webhook-secret-stdin < secret.txt, or set NANSEN_WEBHOOK_SECRET.', 'NOT_A_PIPE'),
      timeout: () => inputError('Timed out reading the webhook secret from stdin. Close the pipe after writing the secret, or redirect a file.', 'INVALID_PARAMS'),
      failed: () => inputError('Could not read the webhook secret from stdin. Check the input and try again.', 'INVALID_PARAMS'),
      tooLarge: () => inputError('Webhook secret input exceeds 4096 bytes. Provide a single secret.', 'INVALID_PARAMS'),
    },
  });
  const secret = raw.trim();
  if (!secret) throw inputError('No webhook secret received on stdin. Pipe the secret or redirect a file that contains it.', 'MISSING_PARAM');
  if (hasControlChars(secret)) throw inputError('Webhook secret input must be a single line without control characters.', 'INVALID_PARAMS');
  return secret;
}
