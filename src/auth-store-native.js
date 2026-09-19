// Runs only inside the guarded helper process, never in the CLI event loop.
import { parentPort, workerData } from 'node:worker_threads';
import { Entry } from '@napi-rs/keyring';
try {
  const { operation, account, data } = workerData;
  const entry = new Entry('nansen-cli-api-auth-v1', account, { linux: { store: 'secret-service' } });
  let value;
  if (operation === 'set') { entry.setSecret(Buffer.from(data, 'base64')); value = true; }
  else if (operation === 'get') { const bytes = entry.getSecret(); value = bytes == null ? null : Buffer.from(bytes).toString('base64'); }
  else if (operation === 'delete') value = entry.deleteCredential();
  else throw new Error();
  parentPort.postMessage({ value });
} catch { parentPort.postMessage({ error: 'STORE_UNAVAILABLE' }); }
