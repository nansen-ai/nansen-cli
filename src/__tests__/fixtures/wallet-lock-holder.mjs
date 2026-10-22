import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, home, enteredPath, releasePath] = process.argv.slice(2);
process.env.HOME = home;
process.env.USERPROFILE = home;

const walletUrl = pathToFileURL(path.join(repo, 'src', 'wallet.js')).href;
const { withWalletMutationLock } = await import(`${walletUrl}?holder=${process.pid}`);

withWalletMutationLock(() => {
  fs.writeFileSync(enteredPath, String(process.pid));
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(releasePath)) Atomics.wait(cell, 0, 0, 10);
});
