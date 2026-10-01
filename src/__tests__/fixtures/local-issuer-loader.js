const credentials = new URL('../../auth-credentials.js', import.meta.url).href;
export async function load(url, context, nextLoad) {
  if (url !== credentials) return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: `
    export * from ${JSON.stringify(credentials + '?original')};
    import { trustedIssuer as original } from ${JSON.stringify(credentials + '?original')};
    export function trustedIssuer(audience) {
      return audience === 'http://localhost:54321' ? audience : original(audience);
    }
  ` };
}
