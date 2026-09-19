// Test-process preload, also inherited by spawned CLI/npm processes. No service
// traffic may escape a missed fetch mock. Registry is permitted only for the
// package installation test's explicit npm process, never the installed CLI.
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
let entry = process.argv[1] || '';
try { entry = require('node:fs').realpathSync(entry); } catch { /* not a file entry */ }
const registry = process.env.NANSEN_TEST_PACKAGE_INSTALL === '1' && /npm-cli\.js$/.test(entry);
function allowed(host) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) || (registry && host === 'registry.npmjs.org');
}
function checked(host) { if (!allowed(host)) throw new Error('Test blocked outbound connection'); }
for (const [object, key] of [[net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect']]) {
  const original = object[key];
  object[key] = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const first = values[0];
    if (typeof first === 'object') { if (!first.path) checked(first.host || first.hostname || 'localhost'); }
    else if (typeof first !== 'string' || /^\d+$/.test(first)) checked(typeof values[1] === 'string' ? values[1] : 'localhost');
    return original.apply(this, args);
  };
}
const lookup = dns.lookup;
dns.lookup = function (hostname, ...args) { checked(hostname); return lookup.call(this, hostname, ...args); };
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (hostname, ...args) { checked(hostname); return promiseLookup.call(this, hostname, ...args); };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...args) => { checked(new URL(typeof url === 'string' || url instanceof URL ? url : url.url).hostname); return realFetch(url, ...args); };
require('node:diagnostics_channel').channel('undici:request:create').subscribe(({ request }) => checked(new URL(request.origin).hostname));
for (const protocol of ['node:http', 'node:https']) {
  const module = require(protocol);
  for (const key of ['request', 'get']) {
    const original = module[key];
    module[key] = function (...args) {
      const first = args[0];
      if (typeof first === 'string' || first instanceof URL) checked(new URL(first).hostname);
      else if (!first.socketPath) checked(first.hostname || first.host || 'localhost');
      return original.apply(this, args);
    };
  }
}
