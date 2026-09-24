import { CommandError } from './api.js';

const MAX_KEY_BYTES = 4096;

function inputError(message, code) {
  return new CommandError(message, code, { error: code, message });
}

// Explicit stdin input keeps secrets out of command arguments and shell history.
export async function readApiKeyInput(input, isTTY = input.isTTY, { timeoutMs = 30_000 } = {}) {
  if (isTTY) throw inputError('Pipe an API key or redirect a key file into --api-key-stdin. For a hidden terminal prompt, use nansen login --human.', 'NOT_A_PIPE');
  const chunks = [];
  let size = 0;
  const timeoutError = inputError('Timed out reading the API key from stdin. Close the pipe after writing a single key, or redirect a key file.', 'API_KEY_INPUT_TIMEOUT');
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError), timeoutMs); });
  try {
    const iterator = input[Symbol.asyncIterator]();
    while (true) {
      const { done, value } = await Promise.race([iterator.next(), timeout]);
      if (done) break;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += bytes.length;
      if (size > MAX_KEY_BYTES) break;
      chunks.push(bytes);
    }
  } catch (error) {
    if (error === timeoutError) throw timeoutError;
    throw inputError('Could not read the API key from stdin. Check the input and try again.', 'API_KEY_INPUT_FAILED');
  } finally {
    clearTimeout(timer);
    input.destroy?.();
  }
  if (size > MAX_KEY_BYTES) throw inputError('API key input exceeds 4096 bytes. Provide a single API key.', 'INVALID_PARAMS');
  const key = Buffer.concat(chunks).toString('utf8').trim();
  if (!key) throw inputError('No API key received on stdin. Pipe a single key or redirect a key file.', 'API_KEY_REQUIRED');
  if (/\s|\ufffd/u.test(key) || [...key].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw inputError('API key input must contain a single key without whitespace or control characters.', 'INVALID_PARAMS');
  return key;
}
