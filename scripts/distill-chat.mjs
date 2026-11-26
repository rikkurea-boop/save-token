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
  return envDir || join(homedir(), ".gemini", "antigravity", "plugin_data", "save-token", "distilled");
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

async function distillConversation(conv, maxChars, cacheFile) {
  let stepCount = 0;
  let userTurnCount = 0;
  let lastCreatedAt = "";
  let firstUserPrompt = "";
  const recentPrompts = [];
  const seenPrompts = new Set();
  const assistantReplies = [];
  const touchedFiles = new Map();
  let lastPlan = "";
  let lastCheckpoint = "";
  const recentErrors = [];

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

  const rl = createInterface({ input: createReadStream(conv.transcriptPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    stepCount += 1;
    if (o.created_at) lastCreatedAt = o.created_at;
    const type = String(o.type || "");

    if (type === "USER_INPUT") {
      userTurnCount += 1;
      for (const p of extractUserPromptsFromContent(o.content)) pushPrompt(p);
    } else if (type === "PLANNER_RESPONSE") {
      if (typeof o.content === "string" && o.content.trim().length > 20) {
        assistantReplies.push(o.content.trim());
        if (assistantReplies.length > 2) assistantReplies.shift();
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
      if (/Command exited with code [1-9]|Encountered error in/i.test(o.content)) {
        pushError(o.content);
      }
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
  const replyMax = clamp(Math.floor(maxChars * 0.36), 600, 1600, 1400);
  const prevMax = clamp(Math.floor(maxChars * 0.12), 240, 500, 420);

  const sections = [
    `# Distilled Context: ${conv.id}`,
    `- ${metaParts.join(" | ")}`,
    "",
    "## 1. Mục tiêu & Yêu cầu người dùng",
    promptBullets.length > 0 ? promptBullets.join("\n") : "- (Không có USER_INPUT dạng text)",
    "",
    "## 2. Kết luận & Trạng thái mới nhất",
    latestReply ? clipMultiline(latestReply, replyMax) : "(Chưa có phản hồi kết luận từ model)",
  ];

  if (prevReply && maxChars >= 3000) {
    sections.push("", "### Phản hồi liền trước (rút gọn)", clipMultiline(prevReply, prevMax));
  }

  const planOrCheckpoint = lastCheckpoint || lastPlan;
  if (planOrCheckpoint) {
    sections.push("", lastCheckpoint ? "## 3. Checkpoint gần nhất" : "## 3. Kế hoạch gần nhất", clipMultiline(planOrCheckpoint, 500));
  }
  if (orderedFiles.length > 0) {
    sections.push("", "## 4. Tệp đã tạo / chỉnh sửa (mới nhất trước)");
    for (const [fp, n] of orderedFiles) sections.push(`- \`${fp}\` (${n}x)`);
  }
  if (artifacts.length > 0) {
    sections.push("", "## 5. Artifacts", artifacts.map((a) => `- \`${a}\``).join("\n"));
  }
  if (recentErrors.length > 0) {
    sections.push("", "## 6. Lỗi gần nhất", ...recentErrors.map((e) => `- ${e}`));
  }

  const tip = `Tip: cần tra chi tiết cụ thể trong phiên này, chạy thêm --query "<từ khóa>" (không đọc thô transcript.jsonl).`;
  const reservedTip = `\n\n${tip}`;
  const bodyBudget = Math.max(400, maxChars - reservedTip.length);
  const body = clipMultiline(sections.join("\n"), bodyBudget);
  return `${body}${reservedTip}`;
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

main().catch((err) => {
  process.stderr.write(`[distill-chat] Error: ${err?.message || String(err)}\n`);
  process.exit(1);
});
