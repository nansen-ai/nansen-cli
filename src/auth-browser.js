import { spawn } from 'node:child_process';
import { trustedIssuer } from './auth-credentials.js';
export function openAuthBrowser(url, audience, { platform = process.platform, spawnFn = spawn } = {}) {
  const parsed = new URL(url);
  if (parsed.origin !== trustedIssuer(audience) || parsed.pathname !== '/device' || parsed.username || parsed.password || parsed.hash || [...parsed.searchParams.keys()].some(k => k !== 'user_code')) throw new Error('Untrusted verification URL');
  const executable = platform === 'darwin' ? '/usr/bin/open' : platform === 'win32' ? 'powershell.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', '$u = [Console]::In.ReadToEnd(); Start-Process -FilePath $u'] : [url];
  return new Promise(resolve => {
    const child = spawnFn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdin.on('error', () => {});
    child.stdin.end(platform === 'win32' ? url : '');
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}
