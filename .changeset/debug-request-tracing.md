---
"nansen-cli": minor
---

Add `--debug` request tracing. `--debug` (or `NANSEN_DEBUG=1`) prints one line per HTTP request to stderr — method, URL, response status, latency in ms, retry decisions (attempt, reason, delay) and the server request id — so auth, latency, retry and response-shape problems can be diagnosed without guesswork. stdout still carries only the JSON/CSV, so piping is unaffected. The trace never prints credentials or response bodies: header values are withheld entirely, and query-string values are blanked whenever the parameter names a key, token, secret, signature, password or auth, as is any remaining credential-shaped value.
