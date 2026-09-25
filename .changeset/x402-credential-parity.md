---
"nansen-cli": patch
---

Preserve automatic x402 payment for API-key requests and give browser sessions the same behavior on supported HTTP 402 challenges. Existing wallet authorization, payment policy and spending limits remain in force. Authentication, authorization and session-renewal failures never trigger payment; login verification and account checks never pay automatically. Paid retries send the payment credential without the API key or browser token and leave saved authentication unchanged. If a paid retry is denied for authentication, authorization, rate limits or geography, stop without signing another payment option because the transmitted payment's outcome is unconfirmed.
