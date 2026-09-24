
Connect any MCP client to Nansen's streamable HTTP server:

- **Endpoint:** `{{ endpoint }}`
- **Authentication:** `{{ apiKeyHeader }}` header
- **API key:** [{{ apiKeySetupUrlText }}]({{ apiKeySetupUrl }})

One-step install of the hosted [Nansen MCP server](https://docs.nansen.ai/mcp/overview) (`{{ endpoint }}`) into a local MCP client:

```bash
nansen mcp install claude-code       # ~/.claude.json (user scope)
nansen mcp install claude-desktop    # macOS/Windows only; bridges via pinned mcp-remote
nansen mcp install cursor            # ~/.cursor/mcp.json
nansen mcp install cursor --dry-run  # print what would be written (key redacted)
nansen mcp uninstall <client>        # remove the entry (add --dry-run to preview)
```

Uses the API key from `nansen login --human` / `NANSEN_API_KEY`; re-run `install` after rotating your key. Writes are merge-only and atomic: existing servers and settings are preserved, a `.bak` copy is written before every install or uninstall, and the CLI refuses to touch a config it can't parse. Note the client config stores the API key in plaintext — new files are created with `0600` permissions. Restart the client after installing.

**Manual setup**, for other clients or if you would rather not use the CLI — the paths below, and the connection docs at [{{ docsUrlText }}]({{ docsUrl }}).

**One-command (Claude Code):**

```bash
{{ claudeCodeCommand }}
```

**Manual (any streamable-HTTP client):** for example, add this to Cursor's `~/.cursor/mcp.json`:

```json
{{ httpJson }}
```

**Manual (stdio-only clients):** use `mcp-remote` as a bridge. Keep the header name and value in a single `args` entry, and keep the key in `env` rather than in the argument list — `mcp-remote` substitutes `{{ apiKeyEnvRef }}` from the environment:

```json
{{ stdioJson }}
```

`mcp-remote` is pinned to an exact version rather than `@latest` because the bridge handles your API key on every request, and `npx` would otherwise pull a new release automatically. `{{ mcpRemoteVersion }}` is the version this config is tested against. A weekly check reports when a newer release exists; to bump the pin, review the release and follow [MCP client config](AGENTS.md#mcp-client-config).

**Claude Tag (Claude in Slack):** an admin must attach a plugin whose `.mcp.json` points at `{{ endpoint }}` and add a custom credential allowing the host `{{ endpointHost }}`. See the [Claude Tag custom-connections documentation](https://claude.com/docs/claude-tag/admins/connections/custom). Per-user fallback: use Claude Code or Claude Desktop.

