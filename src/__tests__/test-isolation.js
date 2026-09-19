// No test may implicitly load the developer's saved auth or wallets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nansen-unit-home-'));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
delete process.env.NANSEN_API_KEY;
process.env.npm_config_cache = path.join(isolatedHome, 'npm-cache');
process.env.NODE_NO_WARNINGS = '1';
afterAll(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));

// Tests must explicitly inject transports. A missed retirement/analytics mock
// must never send even synthetic credential material to a production service.
globalThis.fetch = async () => { throw new Error('Unexpected outbound fetch: inject a test transport'); };
