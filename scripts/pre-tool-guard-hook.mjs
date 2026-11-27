#!/usr/bin/env node
/**
 * Antigravity PreToolUse Guard Hook (0-LLM, fail-open):
 * 1) Denies raw read_file on transcript*.jsonl (forces 0-LLM distill/resume).
 * 2) Clamps raw read_file without StartLine/EndLine on large text files (>35KB) to lines 1..150.
 * 3) Rewrites noisy single-command shell calls (git status/diff/log, tests, lint/build, install, logs)
 *    through compact-shell.mjs --b64 so raw log spam stays out of LLM context.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "./storage-paths.mjs";

const LARGE_FILE_CAP_BYTES = 35 * 1024;
const DEDUP_MIN_BYTES = 4096;
const DEDUP_TTL_MS = 20 * 60 * 1000;
const DEDUP_PRUNE_MS = 60 * 60 * 1000;
const DEDUP_SECOND_TRY_MS = 2 * 60 * 1000;
const BINARY_OR_MEDIA_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".pdf", ".mp4", ".webm", ".mov", ".avi", ".mp3", ".wav", ".ogg",
  ".zip", ".tar", ".gz", ".7z", ".rar", ".sqlite", ".db", ".db-wal", ".db-shm",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".woff", ".woff2", ".ttf",
]);

const ALLOWLIST_PATTERNS = [
  /^\s*git\s+status\b(?![^\n]*(?:--porcelain|--short|\s-s(?:\s|$)))/i,
  /^\s*git\s+diff\b(?![^\n]*(?:--stat|--name-only|--shortstat|--name-status))/i,
  /^\s*git\s+log\b(?![^\n]*--oneline[^\n]*(?:\s-n\s*(?:[1-9]|10)\b|\s-(?:[1-9]|10)\b))/i,
  /^\s*(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/i,
  /^\s*(?:npx\s+)?(?:vitest|jest)\b/i,
  /^\s*(?:python3?\s+-m\s+)?pytest\b/i,
  /^\s*(?:cargo|go|dotnet)\s+test\b/i,
  /^\s*node\s+[^\n]*--test\b/i,
  /^\s*(?:npm|pnpm|yarn)\s+run\s+(?:build|lint|typecheck)\b/i,
  /^\s*(?:npx\s+)?(?:tsc|eslint|ruff|mypy|flake8)\b/i,
  /^\s*cargo\s+(?:build|check|clippy)\b/i,
  /^\s*(?:npm|pnpm|yarn)\s+(?:install|ci)\b/i,
  /^\s*pip3?\s+install\b/i,
  /^\s*docker(?:\s+compose)?\s+(?:logs|ps)\b/i,
  /^\s*kubectl\s+(?:logs|get)\b/i,
  /^\s*gh\s+(?:pr|issue)\s+list\b/i,
  /^\s*gh\s+run\s+view\b/i,
];

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

function readStdinSafe(timeoutMs = 250) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        resolve(buf.trim() ? JSON.parse(buf) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (buf.length < 65536) buf += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    process.stdin.resume();
  });
}

function resolvePluginDataDir(env = process.env) {
  return resolveDataDir(env);
}

function normFileKey(p) {
  const s = toPosix(resolve(String(p || "")));
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function readDedupStore(statePath) {
  if (!existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeDedupStore(statePath, store) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(store), "utf8");
  } catch {
    // Fail-open if plugin data dir is read-only.
  }
}

function handleReadFile(args, payload = {}, env = process.env) {
  const rawPath = String(args.Path ?? args.path ?? "").trim();
  if (!rawPath) return { decision: "allow" };

  const startLine = args.StartLine ?? args.startLine;
  const endLine = args.EndLine ?? args.endLine;
  const hasRange = startLine != null || endLine != null;

  if (/(?:^|[\\/])\.system_generated[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/i.test(rawPath)) {
    const validSmallSlice =
      Number.isFinite(Number(startLine)) &&
      Number.isFinite(Number(endLine)) &&
      Number(endLine) - Number(startLine) <= 60;
    if (!validSmallSlice) {
      return {
        decision: "deny",
        reason:
          "[save-token] Chặn đọc thô transcript*.jsonl để bảo vệ context. Hãy dùng save_token_resume({ conversationId }) hoặc scripts/distill-chat.mjs --query.",
      };
    }
  }

  const posixPath = toPosix(rawPath);
  const ext = extname(posixPath).toLowerCase();
  if (BINARY_OR_MEDIA_EXTS.has(ext)) return { decision: "allow" };
  if (/\/\.gemini\/antigravity\/mcp\//i.test(posixPath) || /\/SKILL\.md$/i.test(posixPath)) {
    return { decision: "allow" };
  }

  try {
    if (!existsSync(rawPath)) return { decision: "allow" };
    const st = statSync(rawPath);
    if (!st.isFile()) return { decision: "allow" };

    const clampToPreview = !hasRange && st.size > LARGE_FILE_CAP_BYTES;
    const effStart = hasRange ? Math.max(1, Number(startLine) || 1) : 1;
    const effEnd = hasRange
      ? (Number.isFinite(Number(endLine)) ? Number(endLine) : Number.MAX_SAFE_INTEGER)
      : (clampToPreview ? 150 : Number.MAX_SAFE_INTEGER);

    if (String(env?.SAVE_TOKEN_READ_DEDUP || "").toLowerCase() !== "off" && st.size >= DEDUP_MIN_BYTES) {
      const statePath = join(resolvePluginDataDir(env), "read-dedup-state.json");
      const convKey = String(payload?.conversationId || payload?.conversation_id || payload?.session_id || payload?.cwd || "default");
      const fileKey = normFileKey(rawPath);
      const now = Number.isFinite(Number(payload?.nowMs)) ? Number(payload.nowMs) : Date.now();
      const store = readDedupStore(statePath);
      const bucket = Array.isArray(store[convKey])
        ? store[convKey].filter((r) => r && now - Number(r.readAt || 0) <= DEDUP_PRUNE_MS)
        : [];

      const matchIdx = bucket.findIndex(
        (r) =>
          r.file === fileKey &&
          Number(r.mtimeMs) === Math.trunc(st.mtimeMs) &&
          Number(r.size) === st.size &&
          now - Number(r.readAt || 0) <= DEDUP_TTL_MS &&
          Number(r.start) <= effStart &&
          Number(r.end) >= effEnd
      );

      if (matchIdx >= 0) {
        const prev = bucket[matchIdx];
        const allowSecondTry = prev.lastDeniedAt && now - Number(prev.lastDeniedAt) <= DEDUP_SECOND_TRY_MS;
        if (!allowSecondTry) {
          bucket[matchIdx] = { ...prev, lastDeniedAt: now };
          store[convKey] = bucket.slice(-150);
          writeDedupStore(statePath, store);
          const rangeLabel = effEnd === Number.MAX_SAFE_INTEGER ? "toàn tệp" : `${effStart}-${effEnd}`;
          return {
            decision: "deny",
            reason: `[save-token read-dedup] Tệp ${basename(posixPath)} (${rangeLabel}) đã được đọc trong phiên này và chưa thay đổi trên đĩa. Dùng lại ngữ cảnh đã đọc, đổi dải dòng, hoặc gọi lại lần nữa nếu thực sự cần nạp lại.`,
          };
        }
        bucket[matchIdx] = { ...prev, readAt: now, lastDeniedAt: 0 };
        store[convKey] = bucket.slice(-150);
        writeDedupStore(statePath, store);
      } else {
        const filtered = bucket.filter((r) => !(r.file === fileKey && Number(r.start) >= effStart && Number(r.end) <= effEnd));
        filtered.push({
          file: fileKey,
          mtimeMs: Math.trunc(st.mtimeMs),
          size: st.size,
          start: effStart,
          end: effEnd,
          readAt: now,
          lastDeniedAt: 0,
        });
        store[convKey] = filtered.slice(-150);
        writeDedupStore(statePath, store);
      }
    }

    if (clampToPreview) {
      return {
        decision: "allow",
        overwrite: {
          StartLine: 1,
          EndLine: 150,
        },
      };
    }
  } catch {
    return { decision: "allow" };
  }
  return { decision: "allow" };
}

function handleRunCommand(args) {
  const cmd = String(args.CommandLine ?? args.commandLine ?? "").trim();
  const isDaemon = Boolean(args.IsDaemon ?? args.isDaemon);
  if (isDaemon || !cmd || cmd.length > 500) return { decision: "allow" };
  if (/[\r\n]/.test(cmd)) return { decision: "allow" };
  if (/[><|;&`]|&&|\|\||\$\(/.test(cmd)) return { decision: "allow" };
  if (/compact-shell\.mjs|save-token/i.test(cmd)) return { decision: "allow" };

  const matched = ALLOWLIST_PATTERNS.some((re) => re.test(cmd));
  if (!matched) return { decision: "allow" };

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const compactScript = toPosix(join(selfDir, "compact-shell.mjs"));
  const b64 = Buffer.from(cmd, "utf8").toString("base64");
  return {
    decision: "allow",
    overwrite: {
      CommandLine: `node --no-warnings=ExperimentalWarning "${compactScript}" --b64 ${b64}`,
    },
  };
}

export function detectHookFormat(payload = {}) {
  if (payload?.toolCall) return "antigravity";
  const hookEv = String(payload?.hook_event_name || "");
  const toolName = String(payload?.tool_name || "");
  if (hookEv === "BeforeTool" || toolName === "run_shell_command") return "gemini-cli";
  if (hookEv === "preToolUse" || hookEv === "beforeShellExecution" || hookEv === "beforeReadFile") return "cursor";
  if (hookEv === "PreToolUse" || (toolName && payload?.tool_input && !payload?.toolCall)) return "claude";
  return "antigravity";
}

function evaluateClaudePreToolUse(payload, env) {
  const toolName = String(payload?.tool_name || "");
  const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};

  if (toolName === "Bash") {
    const cmdRes = handleRunCommand({ CommandLine: input.command || "" });
    if (cmdRes?.overwrite?.CommandLine) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...input, command: cmdRes.overwrite.CommandLine },
        },
      };
    }
    return {};
  }

  if (toolName === "Read") {
    const hasOffset = input.offset != null;
    const hasLimit = input.limit != null;
    const startLine = hasOffset ? Number(input.offset) : undefined;
    const endLine = hasLimit
      ? (hasOffset ? Number(input.offset) + Number(input.limit) - 1 : Number(input.limit))
      : undefined;
    const readRes = handleReadFile(
      { Path: input.file_path || input.path || "", StartLine: startLine, EndLine: endLine },
      payload,
      env
    );
    if (readRes?.decision === "deny") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: readRes.reason,
        },
      };
    }
    if (readRes?.overwrite?.EndLine != null) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: {
            ...input,
            offset: readRes.overwrite.StartLine ?? 1,
            limit: readRes.overwrite.EndLine ?? 150,
          },
        },
      };
    }
    return {};
  }

  return {};
}

function evaluateGeminiBeforeTool(payload, env) {
  const toolName = String(payload?.tool_name || "").toLowerCase();
  const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (toolName === "read_file" || toolName === "read") {
    const startLine = input.offset ?? input.StartLine ?? input.startLine;
    const endLine = input.limit != null && startLine != null
      ? Number(startLine) + Number(input.limit) - 1
      : (input.EndLine ?? input.endLine ?? input.limit);
    const readRes = handleReadFile(
      { Path: input.path || input.file_path || "", StartLine: startLine, EndLine: endLine },
      payload,
      env
    );
    if (readRes?.decision === "deny") {
      return { decision: "deny", reason: readRes.reason };
    }
  }
  return { decision: "allow" };
}

function evaluateCursorPreTool(payload, env) {
  const hookEv = String(payload?.hook_event_name || "");
  const toolName = String(payload?.tool_name || "").toLowerCase();
  const input = payload?.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (hookEv === "beforeReadFile" || toolName === "read" || toolName === "read_file") {
    const readRes = handleReadFile(
      { Path: input.file_path || input.path || payload?.file_path || "" },
      payload,
      env
    );
    if (readRes?.decision === "deny") {
      return { permission: "deny", agentMessage: readRes.reason };
    }
  }
  return { permission: "allow" };
}

export function evaluatePreToolUse(payload, env = process.env) {
  const format = detectHookFormat(payload);
  if (env?.SAVE_TOKEN_NO_COMPACT === "1") {
    if (format === "claude") return {};
    if (format === "cursor") return { permission: "allow" };
    return { decision: "allow" };
  }
  if (format === "claude") return evaluateClaudePreToolUse(payload, env);
  if (format === "gemini-cli") return evaluateGeminiBeforeTool(payload, env);
  if (format === "cursor") return evaluateCursorPreTool(payload, env);

  const toolName = String(payload?.toolCall?.name || "").toLowerCase();
  const args = payload?.toolCall?.args || {};
  if (toolName === "read_file") return handleReadFile(args, payload, env);
  if (toolName === "run_command") return handleRunCommand(args);
  return { decision: "allow" };
}

async function main() {
  try {
    const payload = await readStdinSafe();
    const out = evaluatePreToolUse(payload);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    process.stdout.write('{"decision":"allow"}\n');
  }
}

const isEntry =
  process.argv[1] &&
  toPosix(process.argv[1]).toLowerCase() === toPosix(fileURLToPath(import.meta.url)).toLowerCase();
if (isEntry) main();
