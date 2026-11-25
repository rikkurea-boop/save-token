# Browser & Frontend-Direct Playbook (4-Tier Token Ladder)

Always climb from Tier 0 -> Tier 3. Never stream/screenshot a page when text trees, CDP, or frontend runtime state can answer in one call.

## Tier 0 — Static Web / Docs / JSON (0 Browser Cost)
1. Call `tools.fetchText(url)` inside `save_token_exec` (strips `<script>/<style>/<nav>/<footer>`, stops on 403/CAPTCHA).
2. Use `search_web` for general facts or documentation summaries.

## Tier 1 — Headless Text-Tree CLI (`agent-browser`, Installed)
Run inside `save_token_exec` (or shell) to drive pages via compact accessibility trees + short refs (`@e1`, `@e2`) without screenshots:
- Core loop: `agent-browser open <url>` -> `agent-browser snapshot -i` -> `agent-browser click @e1` / `fill @e2 "..."` / `get text @e3` -> `agent-browser close`.
- Live user Chrome tab: use `--auto-connect` or `--cdp <port>` when attaching to an open session.
- Inspect React / Network / WebMCP directly without UI scraping:
  - `agent-browser react tree` / `agent-browser react inspect <fiberId>` (component tree, props, hooks, source).
  - `agent-browser network` (spot backend JSON APIs so scripts can query APIs directly).
  - `agent-browser webmcp` (discover declared page tools).
- Always filter bulky CLI output inside `save_token_exec` (`<2KB` returned to chat) and run `agent-browser close` when done. Fallback CLI: `playwright-cli` (if installed).

## Tier 2 — Frontend & Network Direct (`chrome-devtools` MCP)
When debugging localhost or inspecting an open browser tab via `chrome-devtools`:
- Prefer `take_snapshot` (text tree), `evaluate_script` (query DOM/React/state directly), `list_network_requests` + `get_network_request` (inspect API payloads), `get_console_message`, and `click`/`fill`/`fill_form`.
- Avoid `take_screenshot` unless verifying visual layout/CSS rendering.

## Tier 3 — `browser` Subagent (Last Resort)
Only invoke `browser` subagent when Tier 0–2 cannot handle visual interaction or auth flows:
- **Force `Model: "flash"`**; give 1 narrow goal and exact stop condition.
- Extract data via 1 DOM script instead of 20 scroll/screenshot loops; cap returned text `<2KB` (stage large text in scratch and search with `save_token_exec` + FTS5).
- Stop immediately on `google.com/sorry`, reCAPTCHA, Turnstile, or payment gates.

## Frontend Dev Shortcuts (Building Your Own AI Web App)
- **Visual-to-source during dev:** `aidenybai/react-grab` copies exact React component stack, file path, and line numbers on click (`Ctrl+C`) so agents edit source directly without grepping or screenshots.
- **Agent-native runtime:** `webmachinelearning/webmcp` (`document.modelContext` / `useMcpTool`) exposes typed app actions directly to agents with zero UI scraping.
