// Runs only inside the guarded helper process, never in the CLI event loop.
import { parentPort, workerData } from 'node:worker_threads';
let Entry;
try {
  ({ Entry } = await import('@napi-rs/keyring'));
  if (typeof Entry !== 'function') throw new Error();
}
catch { Entry = undefined; parentPort.postMessage({ error: 'BINDING_MISSING' }); }
if (Entry) {
try {
  const { operation, account, data } = workerData;
  const entry = new Entry('nansen-cli-api-auth-v1', account, { linux: { store: 'secret-service' } });
  let value;
  if (operation === 'set') { entry.setSecret(Buffer.from(data, 'base64')); value = true; }
  else if (operation === 'get') { const bytes = entry.getSecret(); value = bytes == null ? null : Buffer.from(bytes).toString('base64'); }
  else if (operation === 'delete') value = entry.deleteCredential();
  else throw new Error();
  parentPort.postMessage({ value });
} catch (error) {
  // The binding exposes GenericFailure for both cases. Recognize only the
  // upstream Secret Service refusal; never forward native messages or secrets.
  const locked = process.platform === 'linux' && /Secret Service: unlock prompt was dismissed/.test(error?.message || '');
  parentPort.postMessage({ error: locked ? 'STORE_LOCKED' : 'STORE_UNAVAILABLE' });
}
}
