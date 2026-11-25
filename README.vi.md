# save-token

**Ngôn ngữ:** [English](./README.md) | Tiếng Việt

MCP server, bộ quy tắc CLI-first, thang tối ưu trình duyệt 4 tầng và **bàn giao phiên chat 0-LLM** giúp tiết kiệm token toàn diện cho các tác nhân lập trình & nghiên cứu AI — **không phụ thuộc thư viện npm ngoài**.

Hoạt động trên **Antigravity**, **Claude Code**, **Codex**, **DeepSeek Harness (`dsh`)**, **Cursor**, **Gemini CLI** và mọi trình hỗ trợ MCP stdio chỉ với **Node.js `>= 22.5`** tích hợp sẵn (`node:sqlite`, `node:vm`, `node:child_process`).

---

## Các nền tảng hỗ trợ

| Nền tảng | Vị trí cấu hình & Skill | Lệnh cài đặt |
| :--- | :--- | :--- |
| **Tự động nhận diện (Khuyên dùng)** | Tự quét các công cụ có sẵn trên máy + cài `~/.save-token` & `~/.agents/skills/save-token` | `node install.mjs` |
| **Antigravity** | `~/.gemini/config/plugins/save-token` (`plugin.json`, `mcp_config.json`, `skills/`, `rules/`) | `node install.mjs --target antigravity` |
| **Claude Code** | `~/.claude.json` (`mcpServers.save-token`) + `~/.claude/skills/save-token` | `node install.mjs --target claude` |
| **Codex** | `~/.codex/config.toml` (`[mcp_servers.save-token]`) + `~/.agents/skills/save-token` | `node install.mjs --target codex` |
| **DeepSeek Harness (`dsh`)** | `~/.agents/skills/save-token` + `~/.dsh/save-token.cordis.yml` + `~/.dsh/save-token.AGENTS.md` | `node install.mjs --target dsh` |
| **Cursor** | `~/.cursor/mcp.json` + `~/.agents/skills/save-token` | `node install.mjs --target cursor` |
| **Gemini CLI** | `~/.gemini/settings.json` + `~/.agents/skills/save-token` | `node install.mjs --target gemini-cli` |
| **Tất cả nền tảng** | Cài cho toàn bộ 6 nền tảng trên mà không ghi đè cấu hình cũ | `node install.mjs --target all` |

> **Tùy chọn:** Thêm `--dry-run` để xem trước thay đổi, `--skip-browser` nếu không muốn tự cài `agent-browser`, hoặc `--uninstall --target <tên>` để gỡ sạch `save-token` mà giữ nguyên các MCP server khác.

---

## 6 Công cụ MCP

1. **`save_token_exec`**: REPL JavaScript cục bộ (`state` giữ xuyên lượt, ``await $`...`.compact()`` nén log kiểu RTK giảm 60–90%, `tools.fetchText(url)` đọc web tĩnh/JSON sạch mã rác, `tools.detectClis()`, `tools.saveMemory`/`loadMemory`, `tools.glob`/`grep`/`readMany`/`edit`/`batchReplace`) kèm tự động index **SQLite FTS5 BM25 + Trigram** và cắt JSON giữ cấu trúc hợp lệ.
2. **`save_token_poll`**: Theo dõi, chờ hoặc hủy tiến trình nền khởi chạy từ `tools.spawnBg(cmd)` với tùy chọn nén `.compact` và lọc `intent`.
3. **`save_token_search`**: Truy vấn lại dữ liệu/output lớn đã index xuyên qua cả phiên cũ và phiên mới.
4. **`save_token_handoff`**: Đóng gói bàn giao ngữ cảnh **0 token LLM** — lưu các khóa `state` đã chọn vào `kv_memory` và xuất tệp `.md` cô đọng (hỗ trợ trích xuất prompt/file sửa/lỗi từ `transcriptPath` hoặc `conversationId`, bao gồm cả lời thoại Voice Mode).
5. **`save_token_resume`**: Khôi phục 3 tầng (`()` xem danh sách gọn -> `({ handoffId: "latest" })` đọc tóm tắt & khóa nhớ -> `save_token_search` / `tools.loadMemory`).
6. **`save_token_stats`**: Thống kê thực `rawProcessed` vs `returnedToContext`, `%` tiết kiệm, `state`, `kv_memory`, nguồn FTS5 và tác vụ nền.

---

## Cài đặt nhanh

```bash
git clone https://github.com/rikkurea-boop/save-token.git
cd save-token
npm test                  # Chạy 14 bài test MCP E2E + test cài đặt 6 nền tảng
node install.mjs          # Tự động nhận diện và cấu hình các công cụ AI trên máy
```

### Lưu ý thêm cho DeepSeek Harness (`dsh`)
Lệnh `node install.mjs --target dsh` sẽ cài skill vào `~/.agents/skills/save-token` (được `@deepseek-ai/dsh-skill-filesystem` tự động nạp) và tạo sẵn tệp `~/.dsh/save-token.cordis.yml`. Bạn chỉ cần chép khối `- id: mcp-save-token` vào mục `plugins:` trong `cordis.yml` đang dùng (xem mẫu [`adapters/dsh-cordis.yml`](./adapters/dsh-cordis.yml)).

### Trình duyệt CLI mặc định (`agent-browser`)
Khi chạy `node install.mjs`, bộ cài đặt sẽ **tự động cài [`agent-browser`](https://github.com/vercel-labs/agent-browser) toàn cục** (`npm install -g agent-browser`) nếu máy chưa có sẵn, giúp điều khiển trình duyệt không cần chụp ảnh (`snapshot -i` với ref ngắn `@e1`, đọc React Fiber `react`, soi API `network`, `webmcp`). Thêm cờ `--skip-browser` nếu bạn chỉ muốn cài MCP server và skill.

---

## Yêu cầu & Kiểm chứng
- **Node.js `>= 22.5.0`** (khuyên dùng Node 24+ vì tích hợp sẵn `node:sqlite`).
- 0 thư viện npm ngoài khi chạy.
- Đã kiểm chứng trên Windows 11 và macOS Apple Silicon (`arm64`): `npm test` (`server/test-save-token.mjs` + `server/test-installer.mjs`).

## Tác giả & Bản quyền
- **Tác giả:** [Rikku_desu~](https://github.com/rikkurea-boop)
- **Kho mã nguồn:** [https://github.com/rikkurea-boop/save-token](https://github.com/rikkurea-boop/save-token)
- **Giấy phép:** [MIT](./LICENSE)
