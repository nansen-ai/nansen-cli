---
"nansen-cli": patch
---

Preserve automatic x402 payment for API-key requests and give browser sessions the same behavior on supported HTTP 402 challenges. Existing wallet authorization, payment policy, spending limits and protection against duplicate payment remain in force. Authentication, authorization and session-renewal failures never trigger payment, and login verification never pays. Paid retries send the payment credential without the API key or browser token and leave saved authentication unchanged.
