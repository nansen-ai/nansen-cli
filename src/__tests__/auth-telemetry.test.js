import { afterEach, it, expect, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
const secret = 'SYNTHETIC-PRIVATE-CODE';
async function setup(optout) {
  vi.stubEnv('NANSEN_NO_TELEMETRY', '0'); vi.stubEnv('DO_NOT_TRACK', '0');
  if (optout) vi.stubEnv(optout, '1');
  vi.resetModules();
  const events = [];
  const fetch = vi.fn(async (url, options) => {
    expect(url).toBe('https://bi-data-sources.nansen.ai/events-service-68ifmnpsx2uq7cgab8dw/v2/event');
    events.push(JSON.parse(options.body)); return new Response('{}');
  });
  vi.stubGlobal('fetch', fetch);
  const { runCLI } = await import('../cli.js');
  return { runCLI, fetch, events };
}
it.each(['login', 'logout'])('actual %s event serialization excludes positional, flag, value, host and error secrets', async command => {
  const { runCLI, events, fetch } = await setup();
  for (const fail of [false, true]) {
    const handler = vi.fn(async () => { if (fail) throw Object.assign(new Error(secret), { code: secret, status: secret }); });
    await runCLI([command, secret, '--chain', 'synthetic-private-host.example', `--${secret}`, '--api-key', secret, '--no-browser'], {
      commandOverrides: { [command]: handler }, output: vi.fn(), errorOutput: vi.fn(), exit: vi.fn(),
    });
    expect(handler).toHaveBeenCalledOnce();
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [i, event] of events.entries()) {
    expect(event.path).toBe(`/${command}`);
    expect(event.properties.flags.sort()).toEqual(['--api-key', '--no-browser']);
    expect(event.properties).not.toHaveProperty('chain'); expect(event.properties).not.toHaveProperty('status'); expect(event.properties).not.toHaveProperty('from_cache');
    if (i === 1) expect(event.properties.error_code).toBe('AUTH_FAILED');
    expect(JSON.stringify(event)).not.toContain(secret); expect(JSON.stringify(event)).not.toContain('synthetic-private-host');
  }
});
it.each(['NANSEN_NO_TELEMETRY', 'DO_NOT_TRACK'])('auth success and failure honor %s with zero network', async optout => {
  const { runCLI, fetch } = await setup(optout);
  for (const fail of [false, true]) await runCLI(['login', secret], { commandOverrides: { login: async () => { if (fail) throw new Error(secret); } }, output: vi.fn(), errorOutput: vi.fn(), exit: vi.fn() });
  expect(fetch).not.toHaveBeenCalled();
});
it('auth status and doctor offline never send telemetry or other network even when telemetry is enabled', async () => {
  const { runCLI, fetch } = await setup();
  for (const args of [['auth', 'status'], ['doctor', '--offline']]) await runCLI(args, { output: vi.fn(), errorOutput: vi.fn(), exit: vi.fn() });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['AUTH_TIMEOUT', 'AUTH_CANCELLED'])('actual public serialization retains fixed %s and honors opt-outs', async code => {
  for (const optout of [undefined, 'NANSEN_NO_TELEMETRY', 'DO_NOT_TRACK']) {
    const { runCLI, events, fetch } = await setup(optout);
    await runCLI(['logout', secret, '--chain', secret], { commandOverrides: { logout: async () => { throw Object.assign(new Error(secret), { code }); } }, output: vi.fn(), errorOutput: vi.fn(), exit: vi.fn() });
    if (optout) expect(fetch).not.toHaveBeenCalled();
    else { expect(events[0].properties.error_code).toBe(code); expect(JSON.stringify(events)).not.toContain(secret); }
  }
});
