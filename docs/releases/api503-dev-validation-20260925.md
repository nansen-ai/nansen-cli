# Dev validation closeout, September 25

The installed macOS archive passed the remaining direct refresh and full-session revocation check. This closes that test gap, not production or publication approval. The broader dev acceptance decision is pending independent evidence review.

## What ran

- Unpublished CLI source `a5f452935dafc91775ed7e0c4b81473c93ea7846`, archive SHA256 `3df4a1c57538ec5296343a82e193653bdb33208937dfc863cf0a5dc445465e30`.
- Real macOS Keychain in an unlocked local Terminal. Two fresh browser approvals for the same external test account.
- API image `b410f52@sha256:5c29d2cf6f6e55487e7bfff47d776a5b3c3d397640ce0f17de8d1146eb2d4e92`; authservice `fdcc167a6e98c0046011fe16b4722e965d9e1231`.
- Only free account calls. Research admission remained disabled.

## Results

| Check | Result |
| --- | --- |
| A before and after direct refresh, independent B | All returned 200 for the expected account |
| Retire A, then actual CLI logout | Retirement recorded; saved native credential removed; no operation journals left |
| A original and refreshed tokens after retirement | Both returned 401 in two consecutive samples while unexpired |
| Independent B | Returned 200 throughout and beyond another 45-second cache observation window |
| Final sample, 01:23:38 UTC | A original 401, A refreshed 401, B 200; each token had over 3,400 seconds remaining |
| Cleanup | Both local credentials removed; B retirement recorded, without a subsequent server-rejection probe |
| Dev deployment | Account and research admission restored to false, verified generation 2509 |

The first sample rejecting both A tokens began 26.902 seconds after the retirement receipt. Its requests completed about 28 seconds after receipt. That is an observed result, not an upper-bound service guarantee. Both tokens initially remained usable during propagation.

The runner refreshed with the installed `refreshSession` function, retained the parent securely as cleanup authority, retired using the child, and then ran actual CLI logout on the parent. It did not exercise automatic renewal scheduling, rotated-credential persistence or concurrent renewal. The September 23 automatic-renewal walkthrough and the separate source comparison retain their original scope. The interrupted September 24 attempt is not relabeled as passing.

## Combined evidence and remaining boundaries

Earlier evidence covers browser approval, identity and scope rejection, same-account API-key/browser billing comparison, restart, automatic renewal on the September 23 archive, and synthetic crash recovery on the current archive with the real Keychain. The isolated API/MCP PostgreSQL-outage tests cover consumer behavior, not live ingress or workload-token exchange. The corrected fresh-handler/prune fixture is not a database restart or retention-age test.

Di waived the live zero-credit check. It is waived, not passed. This proposed preview covers local macOS arm64 GUI terminals with an unlocked Keychain and local home directory. Linux live remote ceremony, Windows, desktop cancellation, OS login/PAM/reboot and background execution remain unqualified.

Production remains held for operational clock/fleet/retention, abuse-capacity and alert validation, plus a rollout decision. Publication remains held for a release owner, distribution channel and compatible recovery artifact. These requirements are not satisfied by this test or by merging these docs. API-503 includes normal release, so completing a bounded dev validation does not by itself complete the parent ticket.

## Evidence

[Structured record](api508-evidence.json), fields `currentDevValidation20260925` and the separately dated earlier records. Full sanitized result retained as `cli-release-validation-20260924/server-recheck-3/result.json`, with its SHA256 recorded in the structured record. No credentials are included.
