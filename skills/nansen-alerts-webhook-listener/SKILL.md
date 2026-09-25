---
name: nansen-alerts-webhook-listener
description: Set up a local webhook server to receive Nansen smart alerts in real-time with HMAC signature verification and public tunneling. Use when a user wants to listen for alerts on their local machine.
metadata:
  openclaw:
    requires:
      bins:
        - nansen
        - node
    primaryEnv: NANSEN_API_KEY
    install:
      - kind: node
        package: nansen-cli
        bins: [nansen]
allowed-tools: Bash(nansen:*), Bash(node:*), Bash(npx:*), Bash(ngrok:*), Write
---
## Authentication

Nansen account API calls accept a selected `nansen:api` browser session or conventional API key with the same permissions. `NANSEN_API_KEY` takes precedence; optional `primaryEnv` preserves configured-key injection. Run `nansen auth status` for offline selection. Cached access expiry alone permits automatic renewal during an authorized task. Stop on anonymous selection, invalid state, blocked/uncertain renewal or actual auth failure; never drop a credential or fall back to anonymous x402 payment. Browser login does not grant wallet signing, privileged service identity or a persistent MCP integration key. Preserve all confirmation, signing, sanctions and geographic checks below. Browser rollout acceptance is still pending.



# Alert Webhook Listener

Set up a local HTTP server to receive Nansen smart alert webhook payloads in real-time.

## How It Works

Nansen smart alerts support a **webhook** channel type. When an alert fires, Nansen sends an HTTP POST with a JSON payload to your webhook URL. This skill sets up:

1. A local HTTP server (Node.js, zero external dependencies) that receives and displays alert payloads
2. HMAC-SHA256 signature verification so only authentic Nansen payloads are accepted
3. A public tunnel so Nansen's servers can reach your local machine

**This skill does NOT create or modify alerts.** It sets up the listener infrastructure and then provides a summary of what the user needs to do to start receiving alerts.

**OpenClaw users:** If OpenClaw is running locally on the same machine, the webhook server can forward verified alert payloads to OpenClaw's Gateway (`/hooks/agent`), triggering an agent turn for each alert. Set the `OPENCLAW_GATEWAY_URL` env var to enable this. See the **OpenClaw Integration** section below.

## Security Warning

**Before proceeding, inform the user:**

> This skill starts an HTTP server on your machine and exposes it to the internet via a tunnel (ngrok or localtunnel). While the server only binds to localhost (`127.0.0.1`) — meaning no one on your local network can access it directly — the tunnel creates a public URL that **anyone on the internet** can send requests to.
>
> **Mitigations in place:**
> - HMAC-SHA256 signature verification rejects all requests not signed by Nansen
> - 1 MB body size limit prevents memory abuse
> - Only `POST /webhook` and `GET /health` are accepted; everything else returns 404
>
> **You should be aware that:**
> - The tunnel URL is publicly discoverable (ngrok URLs can be enumerated)
> - Unsigned requests still reach your machine — they're rejected, but the connection is made
> - Stop the tunnel when you're done to close the public endpoint

Wait for the user to confirm they want to proceed before continuing.

## Execution Plan

Follow these steps **in order**. Do not skip signature verification — it is mandatory.

### Step 0: Choose a tunnel provider

Before starting, ask the user which tunnel provider they want to use:

| | **ngrok** (recommended) | **localtunnel** |
|---|---|---|
| Stability | Stable — persistent connections with keepalive | Flaky — free relay drops idle connections without warning, tunnels die randomly |
| Install | `brew install ngrok` + free account at ngrok.com | Zero install (`npx localtunnel`) |
| HTTPS | Yes | Yes |
| Auth required | Yes (free authtoken from ngrok.com) | No |

**Recommend ngrok.** localtunnel is convenient but unreliable — in testing, tunnels silently exit after minutes, causing alerts to fail with "503 Tunnel Unavailable". ngrok maintains stable connections.

Check if ngrok is available:
```bash
which ngrok && ngrok version
```

If not installed, tell the user:
1. `brew install ngrok` (or download from ngrok.com)
2. Create a free account at ngrok.com and copy the authtoken
3. `ngrok config add-authtoken <token>`

If the user prefers localtunnel or can't install ngrok, proceed with localtunnel but warn them that the tunnel may drop and they'll need to restart it and update their alert's webhook URL.

### Step 1: Generate a webhook secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store the output — you need it for both the server and the alert configuration. **Never log or echo the secret after this point.**

### Step 2: Write the webhook receiver script

Create `nansen-webhook-server.mjs` in the current working directory. Use **only** Node.js built-in modules (`node:http`, `node:crypto`). No `npm install` required.

**Requirements — do not deviate:**

| Requirement | Detail |
|---|---|
| Bind address | `127.0.0.1` only — **never** `0.0.0.0` |
| Default port | `9477` (override via `PORT` env var) |
| Webhook path | `POST /webhook` — reject all other method/path combos with 404 |
| Health check | `GET /health` → 200 `{"status":"ok"}` |
| Signature verification | Verify `x-nansen-signature` header using HMAC-SHA256 with timing-safe comparison. Reject 401 on mismatch. |
| Secret validation | Exit on startup if `WEBHOOK_SECRET` env var is missing or < 16 chars |
| Payload logging | Pretty-print valid JSON payloads to stdout with ISO timestamp |
| Request size limit | Reject bodies > 1 MB (413) to prevent memory abuse |
| Graceful shutdown | Handle `SIGINT` and `SIGTERM` — close server, then exit |
| OpenClaw forwarding | If `OPENCLAW_GATEWAY_URL` env var is set, forward verified payloads to `<url>/hooks/agent` via POST. Include `OPENCLAW_AUTH_TOKEN` as Bearer token if set. Log forward success/failure. |
| No dependencies | Only `node:http`, `node:https`, and `node:crypto` — nothing from npm |

**Signature verification — use timing-safe comparison:**

```javascript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  // Nansen sends "sha256=<hex>" — strip the prefix before comparing
  const sig = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false; // length mismatch
  }
}
```

**Full server template:**

```javascript
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = parseInt(process.env.PORT || '9477', 10);
const SECRET = process.env.WEBHOOK_SECRET;
const MAX_BODY = 1_048_576; // 1 MB

// Optional: forward verified payloads to a local OpenClaw Gateway
const OPENCLAW_URL = process.env.OPENCLAW_GATEWAY_URL; // e.g. http://localhost:3000
const OPENCLAW_TOKEN = process.env.OPENCLAW_AUTH_TOKEN;

if (!SECRET || SECRET.length < 16) {
  console.error('WEBHOOK_SECRET env var required (minimum 16 characters).');
  console.error('Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  // Nansen sends "sha256=<hex>" — strip the prefix before comparing
  const sig = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  const expected = createHmac('sha256', SECRET).update(rawBody).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

async function forwardToOpenClaw(payload) {
  if (!OPENCLAW_URL) return;
  const url = `${OPENCLAW_URL.replace(/\/+$/, '')}/hooks/agent`;
  const headers = { 'Content-Type': 'application/json' };
  if (OPENCLAW_TOKEN) headers['Authorization'] = `Bearer ${OPENCLAW_TOKEN}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      console.log(`[${ts()}] Forwarded to OpenClaw (${res.status})`);
    } else {
      console.error(`[${ts()}] OpenClaw forward failed (${res.status})`);
    }
  } catch (err) {
    console.error(`[${ts()}] OpenClaw forward error: ${err.message}`);
  }
}

function ts() { return new Date().toISOString(); }

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"status":"ok"}');
  }

  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404);
    return res.end();
  }

  let size = 0;
  const chunks = [];

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413);
      res.end('{"error":"Payload too large"}');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (res.writableEnded) return;

    const rawBody = Buffer.concat(chunks).toString('utf8');
    const signature = req.headers['x-nansen-signature'];

    if (!verifySignature(rawBody, signature)) {
      console.error(`[${ts()}] REJECTED — invalid signature`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"Invalid signature"}');
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
      console.log(`\n[${ts()}] Alert received:`);
      console.log(JSON.stringify(payload, null, 2));
    } catch {
      console.error(`[${ts()}] WARNING — valid signature but malformed JSON`);
    }

    // Forward to OpenClaw if configured (fire-and-forget — don't block response)
    if (payload) forwardToOpenClaw(payload);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"received":true}');
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    server.close(() => process.exit(0));
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Webhook listener ready — http://127.0.0.1:${PORT}/webhook`);
  if (OPENCLAW_URL) console.log(`OpenClaw forwarding → ${OPENCLAW_URL}/hooks/agent`);
  console.log('Waiting for alerts… (Ctrl+C to stop)\n');
});
```

### Step 3: Start the server and tunnel

Start the server:

```bash
WEBHOOK_SECRET='<secret>' node nansen-webhook-server.mjs
```

Then start a public tunnel so Nansen's servers can reach it.

**ngrok (recommended):**
```bash
ngrok http 9477
```
Get the public URL from ngrok's output or its local API:
```bash
curl -s http://127.0.0.1:4040/api/tunnels | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).tunnels[0]?.public_url))"
```
The webhook URL is `https://<subdomain>.ngrok-free.dev/webhook`.

**localtunnel (fallback — unreliable):**
```bash
npx localtunnel --port 9477
```
Prints a URL like `https://xxx.loca.lt`. The webhook URL is `https://xxx.loca.lt/webhook`.

**Warning:** localtunnel's free relay silently drops connections after minutes. When this happens, all alerts fail with "503 Tunnel Unavailable" until you restart the tunnel and update the alert webhook URL. Use ngrok unless you have a reason not to.

**Note:** Tunnel URLs are ephemeral — they change every restart. For permanent setups, deploy the server to a host with a static URL.

### Step 4: Provide a next-steps summary

**Do NOT create or modify any alerts.** Instead, print a clear summary for the user explaining what was set up and what they need to do next.

The summary MUST include:
1. Confirmation of what was created (the server script path and the generated secret)
2. The commands to start the server and tunnel (with the actual secret filled in)
3. The exact `nansen alerts create` or `nansen alerts update` command they should run, with the `--webhook` and `--webhook-secret` flags filled in with the tunnel URL and secret — but leave the alert-specific flags (`--name`, `--type`, `--chains`, etc.) as placeholders for the user to fill in
4. A reminder that the server and tunnel must be running before the alert is created (Nansen validates the webhook endpoint on creation)
5. A note that tunnel URLs are ephemeral and will change on restart

Example summary format:

```
## Webhook listener ready

**Server script:** ./nansen-webhook-server.mjs
**Port:** 9477

### To start receiving alerts:

1. Start the server (keep this terminal open):
   WEBHOOK_SECRET='<actual-secret>' node nansen-webhook-server.mjs

2. In a new terminal, start the tunnel:
   ngrok http 9477          # recommended
   # or: npx localtunnel --port 9477  (unreliable — tunnel drops silently)

3. Create an alert pointing to your webhook (fill in your alert details):
   nansen alerts create \
     --name '<your alert name>' \
     --type <sm-token-flows|common-token-transfer|smart-contract-call> \
     --chains <chains> \
     --webhook 'https://<your-tunnel-url>/webhook' \
     --webhook-secret '<actual-secret>' \
     [type-specific flags...]

   Or add the webhook to an existing alert:
   nansen alerts update <alert-id> \
     --webhook 'https://<your-tunnel-url>/webhook' \
     --webhook-secret '<actual-secret>'

Note: The tunnel URL changes each time you restart. Update the alert
webhook URL if you restart the tunnel.

See `nansen alerts create --help` for full flag reference per alert type.
```

## Security Checklist

- **Always use a webhook secret** — the server refuses to start without one
- **Always verify signatures** — never accept unverified payloads
- **Bind to localhost only** — the tunnel handles public exposure; direct `0.0.0.0` binding exposes you to unauthenticated traffic
- **Use HTTPS** — both localtunnel and ngrok tunnel via HTTPS by default
- **Body size limit** — the 1 MB cap prevents memory exhaustion from oversized requests
- **Timing-safe comparison** — prevents timing side-channel attacks on the signature

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Invalid signature" on every request | Ensure the **exact same secret** is in `WEBHOOK_SECRET` and `--webhook-secret` |
| "Failed to send welcome message" on alert create | Start the server and tunnel **before** creating the alert |
| No alerts arriving | Check `nansen alerts list --table` — is the alert enabled? Is the webhook URL correct (includes `/webhook`)? |
| Tunnel URL expired / tunnel died | Restart the tunnel, get the new URL, then `nansen alerts update <id> --webhook '<new-url>/webhook'`. If this keeps happening, switch from localtunnel to ngrok. |
| Port already in use | Set a different port: `PORT=9478 WEBHOOK_SECRET='...' node nansen-webhook-server.mjs` and update the tunnel accordingly |

## OpenClaw Integration

If the user is running OpenClaw locally on the same machine, the webhook server can forward verified alert payloads to OpenClaw's Gateway, triggering an agent turn for each alert.

**Flow:** `Nansen → ngrok → webhook server (signature check) → OpenClaw /hooks/agent`

### Additional env vars

| Var | Required | Purpose |
|-----|----------|---------|
| `OPENCLAW_GATEWAY_URL` | Yes | OpenClaw Gateway base URL (e.g. `http://localhost:3000`) |
| `OPENCLAW_AUTH_TOKEN` | If auth enabled | Bearer token for OpenClaw webhook endpoints |

### Start command (with OpenClaw forwarding)

```bash
WEBHOOK_SECRET='<secret>' \
OPENCLAW_GATEWAY_URL='http://localhost:3000' \
OPENCLAW_AUTH_TOKEN='<token>' \
node nansen-webhook-server.mjs
```

The server logs both the alert payload and the OpenClaw forward status. If OpenClaw is unreachable, the forward fails silently (the alert is still logged to stdout).

### Ask the user

Before enabling OpenClaw forwarding, ask:
1. Is OpenClaw running locally? What port?
2. Does their Gateway require auth? If so, what's the Bearer token?

If they don't know or aren't running OpenClaw, skip — the server works fine standalone.

## Notes

- The server uses zero npm dependencies — only Node.js built-ins
- One server can receive alerts from multiple Nansen alerts (as long as they share the same webhook secret)
- For production use, deploy to a cloud host with a static URL and run behind a reverse proxy with TLS
- The `x-nansen-signature` header format is `sha256=<HMAC-SHA256(secret, rawBody)>` — strip the `sha256=` prefix before comparing
