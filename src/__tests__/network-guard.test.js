import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const guard = fileURLToPath(new URL('./fixtures/network-guard.cjs', import.meta.url));
it.each([false, true])('minimal-env child blocks production before transport, loopback proxy=%s', proxy => {
  const child = spawnSync(process.execPath, ['--require', guard, '--input-type=module', '-e', `
    const net = await import('node:net');
    const http = await import('node:http');
    let connections = 0;
    const server = net.createServer(socket => { connections++; socket.destroy(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = 'http://127.0.0.1:' + server.address().port;
    if (${proxy}) { process.env.https_proxy = address; process.env.http_proxy = address; }
    const results = [];
    for (const run of [
      () => fetch('https://idp.nansen.ai/token/refresh', { method: 'POST' }),
      () => http.request('http://api.nansen.ai/'),
      () => net.connect({ host: 'api.nansen.ai', port: 443 }),
    ]) {
      try { await run(); results.push('ESCAPED'); } catch (e) { results.push(e.message); }
    }
    server.close();
    console.log(JSON.stringify({ results, connections }));
  `], { env: { PATH: process.env.PATH, NODE_NO_WARNINGS: '1', ...(proxy && { NODE_USE_ENV_PROXY: '1', https_proxy: 'http://127.0.0.1:9' }) }, encoding: 'utf8', timeout: 10000 });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ results: Array(3).fill('Test blocked outbound connection'), connections: 0 });
});
