#!/usr/bin/env node
/**
 * Zero-LLM conversation transcript distiller for Antigravity.
 * Streams transcript_full.jsonl / transcript.jsonl and emits a compact Markdown summary
 * (with file-mtime cache and targeted --query lookup) so agents never raw-read transcripts.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "./storage-paths.mjs";

const DEFAULT_MAX_CHARS = 4500;
const MIN_MAX_CHARS = 1000;
const MAX_MAX_CHARS = 12000;
const NOISE_PATH_RE = /\/(?:\.system_generated|browser_sandbox|tempmediaStorage)\/|\.metadata\.json$/i;

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;
}

function clip(text, maxLen) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s || s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

function clipMultiline(text, maxLen) {
  const s = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!s || s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 14)).trimEnd()}\n…[trimmed]`;
}

function parseArgs(argv) {
  const opts = { target: "", maxChars: DEFAULT_MAX_CHARS, query: "", noCache: false, out: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max" && i + 1 < argv.length) {
      opts.maxChars = clamp(argv[++i], MIN_MAX_CHARS, MAX_MAX_CHARS, DEFAULT_MAX_CHARS);
    } else if (a.startsWith("--max=")) {
      opts.maxChars = clamp(a.slice(6), MIN_MAX_CHARS, MAX_MAX_CHARS, DEFAULT_MAX_CHARS);
    } else if ((a === "--query" || a === "-q") && i + 1 < argv.length) {
      opts.query = String(argv[++i] || "").trim();
    } else if (a.startsWith("--query=")) {
      opts.query = a.slice(8).trim();
    } else if (a === "--no-cache") {
      opts.noCache = true;
    } else if (a === "--out" && i + 1 < argv.length) {
      opts.out = String(argv[++i] || "").trim();
    } else if (a.startsWith("--out=")) {
      opts.out = a.slice(6).trim();
    } else if (!a.startsWith("-") && !opts.target) {
      opts.target = a.trim();
    }
  }
  return opts;
}

function getBrainRoot() {
  const envDir = process.env.ANTIGRAVITY_BRAIN_DIR?.trim();
  return envDir || join(homedir(), ".gemini", "antigravity", "brain");
}

function getDistillCacheDir() {
  const envDir = process.env.SAVE_TOKEN_DISTILL_DIR?.trim();
  return envDir || join(resolveDataDir(process.env), "distilled");
}

function findTranscriptPath(convDir) {
  const full = join(convDir, ".system_generated", "logs", "transcript_full.jsonl");
  if (existsSync(full)) return full;
  const compact = join(convDir, ".system_generated", "logs", "transcript.jsonl");
  if (existsSync(compact)) return compact;
  return "";
}

function resolveConversation(targetArg) {
  const brainRoot = getBrainRoot();
  if (!existsSync(brainRoot)) {
    throw new Error(`Không tìm thấy thư mục brain: ${toPosix(brainRoot)}`);
  }

  const currentId = String(process.env.ANTIGRAVITY_CONVERSATION_ID || "").toLowerCase();
  const entries = readdirSync(brainRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "tempmediaStorage")
    .map((d) => {
      const dirPath = join(brainRoot, d.name);
      const transcriptPath = findTranscriptPath(dirPath);
      if (!transcriptPath) return null;
      const st = statSync(transcriptPath);
      return { id: d.name, dirPath, transcriptPath, stat: st };
    })
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error("Không có phiên chat nào chứa transcript log trong brain.");
  }

  const query = String(targetArg || "").trim();
  if (!query || query.toLowerCase() === "latest") {
    const candidates = entries
      .filter((e) => !currentId || e.id.toLowerCase() !== currentId)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const chosen = candidates[0] || entries.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)[0];
    return chosen;
  }

  const lower = query.toLowerCase();
  const exact = entries.find((e) => e.id.toLowerCase() === lower);
  if (exact) return exact;

  if (lower.length < 6) {
    throw new Error(`Prefix "${query}" quá ngắn (cần tối thiểu 6 ký tự hoặc UUID đầy đủ / "latest").`);
  }

  const prefixMatches = entries.filter((e) => e.id.toLowerCase().startsWith(lower));
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    throw new Error(`Prefix "${query}" khớp nhiều phiên: ${prefixMatches.map((m) => m.id).join(", ")}`);
  }
  throw new Error(`Không tìm thấy phiên chat khớp "${query}" trong ${toPosix(brainRoot)}.`);
}

function stripWrapperTags(raw) {
  return String(raw || "")
    .replace(/<(voice_instructions|talker_agent_context|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(voice_instructions|talker_agent_context|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?(?=\r?\n#|$)/gi, " ")
    .replace(/<\/?USER_REQUEST>/gi, " ");
}

function extractUserPromptsFromContent(raw) {
  const text = String(raw || "");
  const out = [];
  const blockRe = /<talker_agent_context>([\s\S]*?)<\/talker_agent_context>/gi;
  let blockMatch;
  while ((blockMatch = blockRe.exec(text)) !== null) {
    for (const line of blockMatch[1].split(/\r?\n/)) {
      const m = line.trim().match(/^\[[^\]]+\]\s*user:\s*"(.*)"\s*$/i);
      if (!m) continue;
      const cleaned = clip(m[1].replace(/\\"/g, '"'), 220);
      if (cleaned) out.push(cleaned);
    }
  }

  const plain = clip(stripWrapperTags(text), 220);
  if (plain) out.push(plain);
  return out;
}

function cleanCheckpoint(raw) {
  const cleaned = stripWrapperTags(String(raw || ""))
    .replace(/^#\s*Resuming from a compaction\s*/i, "")
    .replace(/^You are continuing work on the task described above[\s\S]*?This summary was generated at[^\n]*\n?/i, "")
    .replace(/(?:^|\r?\n)#\s*User Requests[\s\S]*?(?=\r?\n##\s|$)/i, "")
    .trim();

  const picked = [];
  for (const heading of ["## 1. Task Overview", "## 6. Active Context", "## 8. Next Steps"]) {
    const idx = cleaned.indexOf(heading);
    if (idx < 0) continue;
    const after = cleaned.slice(idx);
    const nextSec = after.slice(heading.length).search(/\r?\n##\s/);
    const block = nextSec >= 0 ? after.slice(0, heading.length + nextSec) : after;
    picked.push(clipMultiline(block.trim(), 220));
  }
  if (picked.length > 0) {
    return clipMultiline(picked.join("\n"), 520);
  }
  return clipMultiline(cleaned, 500);
}

function inferPrimaryWorkspace(filePaths) {
  const counts = new Map();
  for (const fp of filePaths) {
    if (/\/\.gemini\/antigravity\/brain\//i.test(fp)) continue;
    const m = fp.match(/^([A-Za-z]:\/(?:Users\/[^/]+\/\.gemini\/antigravity\/scratch\/[^/]+|[^/]+\/[^/]+))/i)
      || fp.match(/^(\/(?:Users|home)\/[^/]+\/[^/]+\/[^/]+)/);
    if (!m) continue;
    const root = m[1];
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  let best = "";
  let bestScore = 0;
  for (const [dir, n] of counts.entries()) {
    if (n > bestScore) {
      best = dir;
      bestScore = n;
    }
  }
  return best;
}

function listMarkdownArtifacts(convDir) {
  try {
    return readdirSync(convDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !/\.metadata\.json$/i.test(e.name))
      .map((e) => e.name)
      .slice(0, 12);
  } catch {
    return [];
  }
}

function buildSnippetWindow(text, terms, windowHalf = 220) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const lower = clean.toLowerCase();
  let hitPos = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (hitPos < 0 || idx < hitPos)) hitPos = idx;
  }
  if (hitPos < 0) return clip(clean, windowHalf * 2);
  const start = Math.max(0, hitPos - windowHalf);
  const end = Math.min(clean.length, hitPos + windowHalf);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < clean.length ? "…" : "";
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`;
}

async function runQueryLookup(conv, queryText, maxChars) {
  const terms = [...new Set(queryText.toLowerCase().split(/\s+/).filter(Boolean))];
  if (terms.length === 0) throw new Error("--query không được để trống.");

  const matches = [];
  const rl = createInterface({ input: createReadStream(conv.transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(o.type || "");
    if (!["USER_INPUT", "PLANNER_RESPONSE", "ERROR_MESSAGE", "GENERIC", "CHECKPOINT"].includes(type)) continue;

    let searchable = "";
    if (type === "USER_INPUT") {
      searchable = extractUserPromptsFromContent(o.content).join(" | ");
    } else if (typeof o.content === "string") {
      searchable = stripWrapperTags(o.content);
    }
    if (!searchable.trim()) continue;

    const lower = searchable.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (lower.includes(t)) score += 1;
    }
    if (score === 0) continue;

    matches.push({
      step: o.step_index ?? "?",
      type,
      score,
      snippet: buildSnippetWindow(searchable, terms, 220),
    });
  }

  matches.sort((a, b) => (b.score - a.score) || (Number(b.step) - Number(a.step)));
  const header = `# Query Lookup: ${conv.id}\n- Query: \`${queryText}\` | Matches: ${matches.length}\n`;
  const chunks = [header];
  let used = header.length;

  for (const m of matches.slice(0, 8)) {
    const block = `\n## Step #${m.step} (${m.type})\n${m.snippet}`;
    if (used + block.length > maxChars - 24 && chunks.length > 1) break;
    chunks.push(block);
    used += block.length;
  }
  if (matches.length === 0) {
    chunks.push("\n(Không tìm thấy bước nào khớp từ khóa trong transcript.)");
  }
  return clipMultiline(chunks.join("\n"), maxChars);
}

function pushUniqueLimited(list, item, maxLen, clipLen = 170) {
  const clean = clip(item, clipLen);
  if (!clean) return;
  if (!list.includes(clean)) {
    list.push(clean);
    if (list.length > maxLen) list.shift();
  }
}

function extractAnchorSignals(text, { isUser = false, decisions = [], rejectedApproaches = [], testStatus = [], touchedSymbols = [] } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  for (const rawLn of lines) {
    const ln = rawLn.replace(/^[\s\-*•]+/, "").trim();
    if (!ln || ln.length < 12 || ln.length > 260) continue;
    if (/(?:không dùng|bỏ qua|tránh|loại bỏ|gỡ bỏ|thay vì|tuyệt đối không|do not|don't|never|avoid|skip|removed)\b/i.test(ln)) {
      pushUniqueLimited(rejectedApproaches, ln, 5, 160);
    }
    if (!isUser && /(?:đã hoàn tất|đã chốt|chọn hướng|quyết định|cập nhật|đã sửa|implemented|fixed|switched to|added|updated|gỡ bỏ)\b/i.test(ln)) {
      pushUniqueLimited(decisions, ln, 6, 160);
    }
    if (/(?:ALL \d+ TESTS PASSED|ALL HUD TESTS PASSED|ALL INSTALLER TESTS PASSED|\bPASS\b|\bFAIL\b|Command exited with code \d+)/i.test(ln)) {
      pushUniqueLimited(testStatus, ln, 4, 150);
    }
  }
  if (!isUser) {
    const symRe = /`([A-Za-z_][\w$.-]{2,48})(?:\(\))?`/g;
    let m;
    while ((m = symRe.exec(String(text || ""))) !== null) {
      const sym = m[1];
      if (/^(?:true|false|null|undefined|json|node|http|https|utf8)$/i.test(sym)) continue;
      if (!touchedSymbols.includes(sym)) {
        touchedSymbols.push(sym);
        if (touchedSymbols.length > 14) touchedSymbols.shift();
      }
    }
  }
}

function extractBlockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (b && typeof b === "object" && (b.type === "text" || b.type === "input_text" || b.type === "output_text")) {
        return String(b.text || "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeMultiPlatformRecord(o) {
  if (!o || typeof o !== "object") return null;
  const rawType = String(o.type || "");
  if (["USER_INPUT", "PLANNER_RESPONSE", "CHECKPOINT", "ERROR_MESSAGE", "GENERIC"].includes(rawType)) {
    return null; // Handled directly by Antigravity branch
  }

  const createdAt = o.timestamp || o.created_at || "";
  // Claude Code JSONL
  if ((rawType === "user" || rawType === "assistant") && (o.message || o.content != null)) {
    const msg = o.message && typeof o.message === "object" ? o.message : o;
    const role = msg.role || rawType;
    const content = msg.content ?? o.content;
    const toolUses = [];
    const errors = [];
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "tool_use") {
          toolUses.push({ name: b.name || "", args: b.input || {} });
        } else if (b.type === "tool_result" && b.is_error) {
          const errTxt = typeof b.content === "string" ? b.content : extractBlockText(b.content);
          if (errTxt) errors.push(errTxt);
        }
      }
    }
    return { role: role === "user" ? "user" : "assistant", text: extractBlockText(content), toolUses, errors, createdAt };
  }

  // Codex CLI JSONL
  if (rawType === "response_item" && o.payload && typeof o.payload === "object") {
    const p = o.payload;
    if (p.role === "user" || p.role === "assistant") {
      return { role: p.role, text: extractBlockText(p.content), toolUses: [], errors: [], createdAt };
    }
    if (p.type === "function_call") {
      let args = {};
      try {
        args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : (p.arguments || {});
      } catch {}
      return { role: "assistant", text: "", toolUses: [{ name: p.name || "", args }], errors: [], createdAt };
    }
  }
  if (rawType === "event_msg" && o.payload && typeof o.payload === "object") {
    if (o.payload.type === "user_message") {
      return { role: "user", text: String(o.payload.message || ""), toolUses: [], errors: [], createdAt };
    }
    if (o.payload.type === "agent_message") {
      return { role: "assistant", text: String(o.payload.message || ""), toolUses: [], errors: [], createdAt };
    }
  }

  // Generic chat JSONL
  if (o.role === "user" || o.role === "assistant") {
    return { role: o.role, text: extractBlockText(o.content), toolUses: [], errors: [], createdAt };
  }
  return null;
}

async function distillConversationDetailed(conv, maxChars, cacheFile, opts = {}) {
  const anchorFile = cacheFile ? `${cacheFile.replace(/\.md$/i, "")}.anchor.json` : "";
  let prevAnchor = null;
  if (!opts.noCache && opts.incremental !== false && anchorFile && existsSync(anchorFile)) {
    try {
      const parsed = JSON.parse(readFileSync(anchorFile, "utf8"));
      if (parsed && parsed.version === 1 && Number(conv.stat?.size || 0) >= Number(parsed.sourceSize || 0)) {
        prevAnchor = parsed;
      }
    } catch {
      prevAnchor = null;
    }
  }

  let stepCount = prevAnchor ? Number(prevAnchor.stepCount || 0) : 0;
  let userTurnCount = prevAnchor ? Number(prevAnchor.userTurnCount || 0) : 0;
  let lastCreatedAt = prevAnchor ? String(prevAnchor.lastCreatedAt || "") : "";
  let firstUserPrompt = prevAnchor ? String(prevAnchor.firstUserPrompt || "") : "";
  const recentPrompts = prevAnchor && Array.isArray(prevAnchor.recentPrompts) ? [...prevAnchor.recentPrompts] : [];
  const seenPrompts = new Set(recentPrompts);
  const assistantReplies = prevAnchor && Array.isArray(prevAnchor.assistantReplies) ? [...prevAnchor.assistantReplies] : [];
  const touchedFiles = new Map(prevAnchor && Array.isArray(prevAnchor.touchedFiles) ? prevAnchor.touchedFiles : []);
  let lastPlan = prevAnchor ? String(prevAnchor.lastPlan || "") : "";
  let lastCheckpoint = prevAnchor ? String(prevAnchor.lastCheckpoint || "") : "";
  const recentErrors = prevAnchor && Array.isArray(prevAnchor.recentErrors) ? [...prevAnchor.recentErrors] : [];
  const decisions = prevAnchor && Array.isArray(prevAnchor.decisions) ? [...prevAnchor.decisions] : [];
  const rejectedApproaches = prevAnchor && Array.isArray(prevAnchor.rejectedApproaches) ? [...prevAnchor.rejectedApproaches] : [];
  const testStatus = prevAnchor && Array.isArray(prevAnchor.testStatus) ? [...prevAnchor.testStatus] : [];
  const touchedSymbols = prevAnchor && Array.isArray(prevAnchor.touchedSymbols) ? [...prevAnchor.touchedSymbols] : [];
  const prevLastStep = prevAnchor ? Number(prevAnchor.lastStepIndex ?? -1) : -1;
  let maxSeenStep = prevLastStep;
  let deltaSteps = 0;

  const pushPrompt = (p) => {
    if (!p || seenPrompts.has(p)) return;
    seenPrompts.add(p);
    if (!firstUserPrompt) firstUserPrompt = p;
    recentPrompts.push(p);
    if (recentPrompts.length > 7) recentPrompts.shift();
  };

  const pushError = (msg) => {
    const clean = clip(msg, 180);
    if (!clean || recentErrors[recentErrors.length - 1] === clean) return;
    recentErrors.push(clean);
    if (recentErrors.length > 3) recentErrors.shift();
  };

  let lineSeq = 0;
  const rl = createInterface({ input: createReadStream(conv.transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const stepNum = Number.isFinite(Number(o.step_index)) ? Number(o.step_index) : lineSeq;
    lineSeq += 1;
    if (prevAnchor && stepNum <= prevLastStep) continue;

    deltaSteps += 1;
    if (stepNum > maxSeenStep) maxSeenStep = stepNum;
    stepCount += 1;
    if (o.created_at) lastCreatedAt = o.created_at;
    const type = String(o.type || "");

    if (type === "USER_INPUT") {
      userTurnCount += 1;
      for (const p of extractUserPromptsFromContent(o.content)) {
        pushPrompt(p);
        extractAnchorSignals(p, { isUser: true, rejectedApproaches, testStatus });
      }
    } else if (type === "PLANNER_RESPONSE") {
      if (typeof o.content === "string" && o.content.trim().length > 20) {
        assistantReplies.push(o.content.trim());
        if (assistantReplies.length > 2) assistantReplies.shift();
        extractAnchorSignals(o.content, { isUser: false, decisions, rejectedApproaches, testStatus, touchedSymbols });
      }
      if (Array.isArray(o.tool_calls)) {
        for (const tc of o.tool_calls) {
          const name = String(tc?.name || "");
          const args = tc?.args || tc?.arguments || {};
          if (name === "edit_file" || name === "write_file") {
            const p = toPosix(args.Path || args.path || "");
            if (p && !NOISE_PATH_RE.test(p)) {
              const prev = touchedFiles.get(p) || 0;
              touchedFiles.delete(p);
              touchedFiles.set(p, prev + 1);
            }
          } else if (name === "exit_plan_mode" && typeof args.plan === "string" && args.plan.trim()) {
            lastPlan = clipMultiline(args.plan, 600);
          }
        }
      }
    } else if (type === "CHECKPOINT" && typeof o.content === "string" && o.content.trim()) {
      lastCheckpoint = cleanCheckpoint(o.content);
    } else if (type === "ERROR_MESSAGE" && typeof o.content === "string") {
      pushError(o.content);
    } else if (type === "GENERIC" && typeof o.content === "string") {
      extractAnchorSignals(o.content, { isUser: false, testStatus });
      if (/Command exited with code [1-9]|Encountered error in/i.test(o.content)) {
        pushError(o.content);
      }
    } else {
      const norm = normalizeMultiPlatformRecord(o);
      if (norm) {
        if (norm.createdAt && !o.created_at) lastCreatedAt = norm.createdAt;
        if (norm.role === "user") {
          userTurnCount += 1;
          for (const p of extractUserPromptsFromContent(norm.text)) {
            pushPrompt(p);
            extractAnchorSignals(p, { isUser: true, rejectedApproaches, testStatus });
          }
        } else {
          if (norm.text && norm.text.trim().length > 20) {
            assistantReplies.push(norm.text.trim());
            if (assistantReplies.length > 2) assistantReplies.shift();
            extractAnchorSignals(norm.text, { isUser: false, decisions, rejectedApproaches, testStatus, touchedSymbols });
          }
          for (const tc of norm.toolUses || []) {
            const tName = String(tc?.name || "");
            const args = tc?.args || {};
            if (/^(?:edit|write|multiedit|edit_file|write_file|replace_file_content|apply_patch)$/i.test(tName)) {
              const p = toPosix(args.file_path || args.Path || args.path || "");
              if (p && !NOISE_PATH_RE.test(p)) {
                const prev = touchedFiles.get(p) || 0;
                touchedFiles.delete(p);
                touchedFiles.set(p, prev + 1);
              }
            }
          }
        }
        for (const errText of norm.errors || []) {
          pushError(errText);
        }
      }
    }
  }

  if (anchorFile && conv.stat) {
    try {
      mkdirSync(dirname(anchorFile), { recursive: true });
      writeFileSync(
        anchorFile,
        JSON.stringify({
          version: 1,
          sourceSize: Number(conv.stat.size || 0),
          lastStepIndex: maxSeenStep,
          stepCount,
          userTurnCount,
          lastCreatedAt,
          firstUserPrompt,
          recentPrompts,
          assistantReplies,
          touchedFiles: [...touchedFiles.entries()],
          touchedSymbols,
          decisions,
          rejectedApproaches,
          testStatus,
          lastPlan,
          lastCheckpoint,
          recentErrors,
        }),
        "utf8"
      );
    } catch {
      // Fail-open on read-only cache dirs.
    }
  }

  const orderedFiles = [...touchedFiles.entries()].reverse().slice(0, 12);
  const workspace = inferPrimaryWorkspace([...touchedFiles.keys()]);
  const artifacts = listMarkdownArtifacts(conv.dirPath);
  const updatedStr = lastCreatedAt || new Date(conv.stat.mtimeMs).toISOString();

  const metaParts = [
    `Updated: ${updatedStr}`,
    `Steps: ${stepCount}`,
    `UserTurns: ${userTurnCount}`,
    ...(workspace ? [`Workspace: ${workspace}`] : []),
    `CacheFile: ${toPosix(cacheFile)}`,
  ];

  const tailPrompts = firstUserPrompt ? recentPrompts.filter((p) => p !== firstUserPrompt).slice(-6) : recentPrompts.slice(-6);
  const promptBullets = [
    ...(firstUserPrompt ? [`- [Mở đầu] ${firstUserPrompt}`] : []),
    ...tailPrompts.map((p) => `- ${p}`),
  ];

  const latestReply = assistantReplies[assistantReplies.length - 1] || "";
  const prevReply = assistantReplies.length > 1 ? assistantReplies[assistantReplies.length - 2] : "";
  const replyMax = clamp(Math.floor(maxChars * 0.32), 550, 1500, 1300);
  const prevMax = clamp(Math.floor(maxChars * 0.12), 220, 480, 400);

  const sections = [
    `# Distilled Context: ${conv.id}`,
    `- ${metaParts.join(" | ")}`,
    "",
    "## 1. Mục tiêu & Yêu cầu người dùng",
    promptBullets.length > 0 ? promptBullets.join("\n") : "- (Không có USER_INPUT dạng text)",
    "",
    "## 2. Kết luận & Quyết định đã chốt",
    latestReply ? clipMultiline(latestReply, replyMax) : "(Chưa có phản hồi kết luận từ model)",
  ];

  if (decisions.length > 0) {
    sections.push("", "### Quyết định & Tiến độ đã neo", ...decisions.map((d) => `- ${d}`));
  }
  if (prevReply && maxChars >= 3000) {
    sections.push("", "### Phản hồi liền trước (rút gọn)", clipMultiline(prevReply, prevMax));
  }
  if (rejectedApproaches.length > 0) {
    sections.push("", "## 3. Phương án đã loại & Ràng buộc tránh", ...rejectedApproaches.map((r) => `- ${r}`));
  }

  const planOrCheckpoint = lastCheckpoint || lastPlan;
  if (planOrCheckpoint) {
    sections.push("", lastCheckpoint ? "## 4. Checkpoint gần nhất" : "## 4. Kế hoạch gần nhất", clipMultiline(planOrCheckpoint, 480));
  }
  if (orderedFiles.length > 0) {
    sections.push("", "## 5. Tệp & Biểu tượng đã sửa (mới nhất trước)");
    for (const [fp, n] of orderedFiles) sections.push(`- \`${fp}\` (${n}x)`);
    if (touchedSymbols.length > 0) {
      sections.push(`- Symbols: ${touchedSymbols.slice(-8).map((s) => `\`${s}\``).join(", ")}`);
    }
  }
  if (artifacts.length > 0) {
    sections.push("", "## 6. Artifacts", artifacts.map((a) => `- \`${a}\``).join("\n"));
  }
  if (testStatus.length > 0 || recentErrors.length > 0) {
    sections.push("", "## 7. Trạng thái kiểm thử & Lỗi gần nhất");
    for (const t of testStatus) sections.push(`- [Test] ${t}`);
    for (const e of recentErrors) sections.push(`- [Error] ${e}`);
  }

  const tip = `Tip: cần tra chi tiết cụ thể trong phiên này, chạy thêm --query "<từ khóa>" (không đọc thô transcript.jsonl).`;
  const reservedTip = `\n\n${tip}`;
  const bodyBudget = Math.max(400, maxChars - reservedTip.length);
  const body = clipMultiline(sections.join("\n"), bodyBudget);
  const summaryMd = `${body}${reservedTip}`;
  return {
    summaryMd,
    title: clip(firstUserPrompt || `Phiên ${String(conv.id || "").slice(0, 8)}`, 72),
    workspace,
    firstUserPrompt,
    touchedFiles: orderedFiles.map(([fp]) => fp),
    recentErrors,
    stepCount,
    userTurnCount,
    anchored: {
      lastStepIndex: maxSeenStep,
      deltaSteps,
      decisions,
      rejectedApproaches,
      testStatus,
    },
  };
}

async function distillConversation(conv, maxChars, cacheFile) {
  const details = await distillConversationDetailed(conv, maxChars, cacheFile);
  return details.summaryMd;
}

/** Zero-LLM transcript distiller helper importable by hooks/sidecars without spawning CLI. */
export async function distillTranscriptFile(transcriptPath, { conversationId = "", maxChars = 3600, cacheDir = getDistillCacheDir(), noCache = false, incremental = true } = {}) {
  const resolvedPath = String(transcriptPath || "").trim();
  if (!resolvedPath || !existsSync(resolvedPath)) {
    throw new Error(`Transcript not found: ${resolvedPath}`);
  }
  const st = statSync(resolvedPath);
  let convDir = "";
  if (/[\\/]\.system_generated[\\/]logs[\\/]/i.test(resolvedPath)) {
    convDir = dirname(dirname(dirname(resolvedPath)));
  }
  const inferredId = conversationId || (convDir ? convDir.split(/[\\/]/).pop() : "session");
  const cappedChars = clamp(maxChars, MIN_MAX_CHARS, MAX_MAX_CHARS, 3600);
  const cacheFile = join(cacheDir, `${inferredId}.md`);
  const sourceSig = `<!-- source-sig:${Math.trunc(st.mtimeMs)}:${st.size}:${cappedChars} -->`;
  const details = await distillConversationDetailed(
    { id: inferredId, dirPath: convDir, transcriptPath: resolvedPath, stat: st },
    cappedChars,
    cacheFile,
    { noCache, incremental }
  );
  return { ...details, sourceSig };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const conv = resolveConversation(opts.target);

  if (opts.query) {
    const out = await runQueryLookup(conv, opts.query, opts.maxChars);
    if (opts.out) {
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, `${out}\n`, "utf8");
    }
    process.stdout.write(`${out}\n`);
    return;
  }

  const cacheDir = getDistillCacheDir();
  const cacheFile = join(cacheDir, `${conv.id}.md`);
  const sig = `<!-- distill-v1:${Math.trunc(conv.stat.mtimeMs)}:${conv.stat.size}:${opts.maxChars} -->`;

  if (!opts.noCache && existsSync(cacheFile)) {
    const cachedRaw = readFileSync(cacheFile, "utf8");
    const nl = cachedRaw.indexOf("\n");
    const firstLine = nl >= 0 ? cachedRaw.slice(0, nl).trim() : "";
    if (firstLine === sig) {
      const cleanBody = cachedRaw.slice(nl + 1).trimEnd();
      if (opts.out) {
        mkdirSync(dirname(opts.out), { recursive: true });
        writeFileSync(opts.out, `${cleanBody}\n`, "utf8");
      }
      process.stdout.write(`${cleanBody}\n`);
      return;
    }
  }

  const distilled = await distillConversation(conv, opts.maxChars, cacheFile);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, `${sig}\n${distilled}\n`, "utf8");
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${distilled}\n`, "utf8");
  }
  process.stdout.write(`${distilled}\n`);
}

const isEntry =
  process.argv[1] &&
  toPosix(process.argv[1]).toLowerCase() === toPosix(fileURLToPath(import.meta.url)).toLowerCase();

if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`[distill-chat] Error: ${err?.message || String(err)}\n`);
    process.exit(1);
  });
}
