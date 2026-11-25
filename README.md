# save-token

**Language:** English | [Tiếng Việt](./README.vi.md)

Zero-dependency universal token-saving MCP server, CLI-first playbook, browser tight-scoping ladder, and **0-LLM cross-session handoff** for AI coding & research agents.

Works across **Antigravity**, **Claude Code**, **Codex**, **DeepSeek Harness (`dsh`)**, **Cursor**, **Gemini CLI**, and any stdio MCP host using built-in **Node.js `>= 22.5`** (`node:sqlite`, `node:vm`, `node:child_process`) with **0 npm runtime dependencies**.

---

## Supported Platforms

| Platform | Config / Skill Targets | Install Command |
| :--- | :--- | :--- |
| **Auto-detect (Recommended)** | Detects installed harnesses + installs `~/.save-token` & `~/.agents/skills/save-token` | `node install.mjs` |
| **Antigravity** | `~/.gemini/config/plugins/save-token` (`plugin.json`, `mcp_config.json`, `skills/`, `rules/`) | `node install.mjs --target antigravity` |
| **Claude Code** | `~/.claude.json` (`mcpServers.save-token`) + `~/.claude/skills/save-token` | `node install.mjs --target claude` |
| **Codex** | `~/.codex/config.toml` (`[mcp_servers.save-token]`) + `~/.agents/skills/save-token` | `node install.mjs --target codex` |
| **DeepSeek Harness (`dsh`)** | `~/.agents/skills/save-token` + `~/.dsh/save-token.cordis.yml` + `~/.dsh/save-token.AGENTS.md` | `node install.mjs --target dsh` |
| **Cursor** | `~/.cursor/mcp.json` + `~/.agents/skills/save-token` | `node install.mjs --target cursor` |
| **Gemini CLI** | `~/.gemini/settings.json` + `~/.agents/skills/save-token` | `node install.mjs --target gemini-cli` |
| **All platforms** | Installs every target above without clobbering existing config keys | `node install.mjs --target all` |

> **Options:** Add `--dry-run` to preview changes, `--skip-browser` to skip installing `agent-browser`, or `--uninstall --target <name>` to cleanly remove `save-token` entries without touching your other MCP servers.

---

## 6 MCP Tools

1. **`save_token_exec`**: Persistent JS REPL (`state` across turns, ``await $`...`.compact()`` RTK-style log compactor, `tools.fetchText(url)` clean web/JSON reader, `tools.detectClis()`, `tools.saveMemory`/`loadMemory`, `tools.glob`/`grep`/`readMany`/`edit`/`batchReplace`) with automatic **SQLite FTS5 BM25 + Trigram** indexing and structural JSON truncation.
2. **`save_token_poll`**: Monitor, wait for, or kill background commands spawned by `tools.spawnBg(cmd)` with optional `.compact` and FTS5 `intent`.
3. **`save_token_search`**: Query indexed outputs across current and previous sessions.
4. **`save_token_handoff`**: Zero-LLM session handoff builder that persists selected `state` keys into `kv_memory` and writes a compact `.md` snapshot (also extracts prompts/files/errors when given a `transcriptPath` or Antigravity `conversationId`, including Voice Mode utterances).
5. **`save_token_resume`**: 3-layer progressive disclosure resume (`()` list -> `({ handoffId: "latest" })` summary + keys -> `save_token_search` / `tools.loadMemory`).
6. **`save_token_stats`**: Reports real `rawProcessed` vs `returnedToContext` bytes, `%` saved, `state`, `kv_memory`, FTS5 sources, and jobs.

---

## Quick Start

```bash
git clone https://github.com/rikkurea-boop/save-token.git
cd save-token
npm test                  # Runs 14 MCP E2E tests + cross-platform installer tests
node install.mjs          # Auto-detects & configures your installed agent harnesses
```

### DeepSeek Harness (`dsh`) Extra Step
`install.mjs --target dsh` installs the skill to `~/.agents/skills/save-token` (loaded automatically by `@deepseek-ai/dsh-skill-filesystem`) and writes `~/.dsh/save-token.cordis.yml`. Copy the `- id: mcp-save-token` block into your `cordis.yml` `plugins:` list (see [`adapters/dsh-cordis.yml`](./adapters/dsh-cordis.yml)).

### Default Browser CLI (`agent-browser`)
`node install.mjs` **automatically installs [`agent-browser`](https://github.com/vercel-labs/agent-browser) globally** (`npm install -g agent-browser`) if it is not already on your `PATH`, enabling zero-screenshot browser automation (`snapshot -i` accessibility tree with `@e1` refs, `react`, `network`, `webmcp`). Pass `--skip-browser` if you only want the MCP server and skills.

---

## Requirements & Verification
- **Node.js `>= 22.5.0`** (Node 24+ recommended; uses built-in `node:sqlite`).
- Zero external npm runtime dependencies.
- Verified on Windows 11 and macOS Apple Silicon (`arm64`): `npm test` (`server/test-save-token.mjs` + `server/test-installer.mjs`).

## Author & License
- **Author:** [Rikku_desu~](https://github.com/rikkurea-boop)
- **Repository:** [https://github.com/rikkurea-boop/save-token](https://github.com/rikkurea-boop/save-token)
- **License:** [MIT](./LICENSE)
