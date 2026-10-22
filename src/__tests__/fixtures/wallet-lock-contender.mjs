import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, home, markerPath] = process.argv.slice(2);
process.env.HOME = home;
process.env.USERPROFILE = home;

try {
  const walletUrl = pathToFileURL(path.join(repo, 'src', 'wallet.js')).href;
  const { withWalletMutationLock } = await import(`${walletUrl}?contender=${process.pid}`);
  const result = withWalletMutationLock(() => {
    fs.writeFileSync(markerPath, String(process.pid));
    return path.basename(markerPath);
  });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, code: error.code }));
  process.exitCode = 1;
}
