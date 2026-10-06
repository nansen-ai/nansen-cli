# Managed local file reads

Authentication and trading storage must contain regular files. The CLI refuses symlinked files, hard links, and symlinked directories below its storage root. Trading and cache storage may use an intentionally symlinked root; its target identity is checked again after opening. Authentication requires a link-free root as well. Authentication also rejects files and directories owned by another user or writable by group or other users on POSIX platforms.

`local-file.js` opens with `O_NOFOLLOW` and `O_NONBLOCK` where the platform provides them. It checks the opened descriptor's type, link count, identity, and applicable permissions before reading. It compares the descriptor with the path and checks the containing directories again. A rejected descriptor closes immediately. An unlocked authentication config read retries once after an inode change caused by an atomic update, repeating every check before reading; continued replacement still fails closed. Authentication journals keep their existing 4 KiB limit, measured on the opened descriptor.

These checks do not sandbox a process already running as the user's OS identity. Such a process can edit a regular file in place, change HOME, or manipulate ancestor directories. Directory comparisons detect ordinary replacements but do not provide descriptor-relative traversal like `openat`. Home ancestors may legitimately be symlinks, as with `/var` on macOS. On Windows, POSIX ownership and mode checks do not apply and `O_NOFOLLOW` may be absent; the path and descriptor comparisons still run.

## API-733 paths

| Path | Source and validation |
| --- | --- |
| Authentication config | Fixed `config.json` below the absolute HOME/USERPROFILE directory. Development config is a package-local fallback. A present but unsafe user config fails without selecting the development config. An explicitly supplied environment API key retains precedence. |
| Authentication journals | Fixed `auth-operations` directory, UUID filenames, journal schema validation, and descriptor checks before JSON parsing. |
| Authentication locks | Fixed lock names or UUID journal lock names. Descriptor checks run before native locking. The secure-store worker accepts an absolute directory from its parent and independently validates its lock. |
| Cache inspection | Fixed cache namespaces. Response entries must have 64 hex digits and `.json`. Descriptor checks run before timestamp extraction. Unsafe entries are skipped. Statistics never return cached payloads. |
| Trading and bridge quotes | Quote IDs and transaction hashes form a single filename component. Separators, colons, NUL, and traversal are rejected. Reads, execution-claim release, marker reads, and cleanup reads use descriptor checks. |

Explicit file import options are user-authorized reads and retain their documented behavior. API-733 concerns managed state, where following a link could load unrelated data as credentials or transaction input. Authentication locks and quote-marker writes also validate their descriptors before use. Other writes remain outside this hardening.

Bridge execution shares the swap quote claim. Before signing, it renames the quote to `.executing.json`, flushes the directory on POSIX, and validates the claimed data against the reviewed quote. A definite pre-broadcast rejection releases the claim. A successful or uncertain broadcast requires a flushed execution marker before release. If the marker cannot be read, written, or flushed, execution stops and the claim stays in place. Check bridge status before requesting a new quote. Dry runs and declined confirmation do not claim or consume a quote.

## Verification

`src/__tests__/local-file-security.test.js` exercises real temporary files and production entry points. It checks symlinks, hard links, directory redirection, path traversal, a file replacement during open, journal limits, lock substitution, and quote claims. It asserts that rejected targets never reach `readFileSync`. The secure-store test starts the real guard process and confirms that a linked lock never reaches readiness.

The existing auth recovery, process lifetime, trading, bridge, and cache suites cover normal operation. Bridge regression tests inject marker read, write, and flush failures after a mocked broadcast and verify that a second attempt never signs. They also check concurrent execution and preservation of pre-broadcast retries. No real credential store, funded wallet, or production API is used for the attack fixtures.

Windows CI runs these filesystem fixtures and a real CLI saved-key research request followed by quote creation and a dry run on Node 22 and 24, using only a loopback mock server.
