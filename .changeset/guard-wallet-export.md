---
"nansen-cli": minor
---

Guard `wallet export` against accidental plaintext key disclosure. The default output is now redacted (addresses only — no decryption, no password needed). Printing private keys to stdout requires explicit acknowledgement via `--reveal` (which also warns on stderr when stdout is an interactive terminal), and the new `--file <path>` writes keys to a file created with 0600 permissions (refusing to overwrite) while keeping stdout clean. Scripts that parsed `wallet export` output must add `--reveal` or switch to `--file`. `--file` failures carry machine-readable codes: `FILE_EXISTS` when the path already exists, `FILE_WRITE_FAILED` for any other create/write error.

This safety hardening is intentionally classified as a minor change rather than a major release: it changes an unsafe default to prevent accidental private-key disclosure while preserving explicit export through `--reveal` and `--file`.
