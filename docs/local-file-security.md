# Managed local file reads

Authentication and trading storage must contain regular files. The CLI refuses symlinked files, hard links, and symlinked directories at or below its storage root. Authentication also rejects files and directories owned by another user or writable by group or other users on POSIX platforms.

`local-file.js` opens with `O_NOFOLLOW` and `O_NONBLOCK` where the platform provides them. It checks the opened descriptor's type, link count, identity, and applicable permissions before reading. It compares the descriptor with the path and checks the containing directories again. A rejected descriptor closes immediately. Authentication journals keep their existing 4 KiB limit, measured on the opened descriptor.

These checks do not sandbox a process already running as the user's OS identity. Such a process can edit a regular file in place, change HOME, or manipulate ancestor directories. Directory comparisons detect ordinary replacements but do not provide descriptor-relative traversal like `openat`. Home ancestors may legitimately be symlinks, as with `/var` on macOS. On Windows, POSIX ownership and mode checks do not apply and `O_NOFOLLOW` may be absent; the path and descriptor comparisons still run.

## API-733 paths

| Path | Source and validation |
| --- | --- |
| Authentication config | Fixed `config.json` below the absolute HOME/USERPROFILE directory. Development config is a package-local fallback. A present but unsafe user config fails without selecting the development config. An explicitly supplied environment API key retains precedence. |
| Authentication journals | Fixed `auth-operations` directory, UUID filenames, journal schema validation, and descriptor checks before JSON parsing. |
| Authentication locks | Fixed lock names or UUID journal lock names. Descriptor checks run before native locking. The secure-store worker accepts an absolute directory from its parent and independently validates its lock. |
| Cache inspection | Fixed cache namespaces. Response entries must have 64 hex digits and `.json`. Descriptor checks run before timestamp extraction. Unsafe entries are skipped. Statistics never return cached payloads. |
| Trading and bridge quotes | Quote IDs and transaction hashes form a single filename component. Separators, colons, NUL, and traversal are rejected. Reads, execution-claim release, marker reads, and cleanup reads use descriptor checks. |

Explicit file import options are user-authorized reads and retain their documented behavior. API-733 concerns managed state, where following a link could load unrelated data as credentials or transaction input. Writes outside the changed lock-opening path are not a general filesystem sandbox.

## Verification

`src/__tests__/local-file-security.test.js` exercises real temporary files and production entry points. It checks symlinks, hard links, directory redirection, path traversal, a file replacement during open, journal limits, lock substitution, and quote claims. It asserts that rejected targets never reach `readFileSync`. The secure-store test starts the real guard process and confirms that a linked lock never reaches readiness.

The existing auth recovery, process lifetime, trading, bridge, and cache suites cover normal operation. No real credential store, funded wallet, or production API is used for the attack fixtures.
