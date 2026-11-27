#!/usr/bin/env node
/**
 * Antigravity Stop Hook (0-LLM):
 * Chưng cất snapshot ngữ cảnh hoàn toàn miễn phí khi phiên chat & model đã dừng nhàn rỗi (`fullyIdle === true`).
 * Không bao giờ đánh thức model, không phá prompt cache, luôn trả `{}` và fail-open.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import { createHandoffStore } from "../sidecars/context-hud/handoff-store.mjs";
import { inferBranch, inferTags } from "./context-meta.mjs";
import { distillTranscriptFile } from "./distill-chat.mjs";
import { resolveDbPath } from "./storage-paths.mjs";

const TAIL_BYTES = 65536;
const DEDUP_STEP_GAP = 8;
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

function readStdinSafe(timeoutMs = 250) {
  return new Promise((resolveInput) => {
    if (process.stdin.isTTY) {
      resolveInput({});
      return;
    }
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        resolveInput(buf.trim() ? JSON.parse(buf) : {});
      } catch {
        resolveInput({});
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (buf.length < 32768) buf += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    process.stdin.resume();
  });
}

function resolveTranscriptPath(payload) {
  const raw = String(payload?.transcript_path || payload?.transcriptPath || "").trim();
  if (!raw || !existsSync(raw)) return "";
  if (basename(raw).toLowerCase() === "transcript.jsonl") {
    const sibling = join(dirname(raw), "transcript_full.jsonl");
    if (existsSync(sibling)) return sibling;
  }
  return raw;
}

function readTailRecords(filePath, maxBytes = TAIL_BYTES) {
  const st = statSync(filePath);
  const size = st.size;
  if (!size) return [];

  let text = "";
  if (size <= maxBytes) {
    text = readFileSync(filePath, "utf8");
  } else {
    const fd = openSync(filePath, "r");
    try {
      const start = size - maxBytes;
      const buf = Buffer.allocUnsafe(maxBytes);
      const bytesRead = readSync(fd, buf, 0, maxBytes, start);
      text = buf.subarray(0, bytesRead).toString("utf8");
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    } finally {
      closeSync(fd);
    }
  }

  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object") records.push(obj);
    } catch {
      // Skip partial/malformed trailing lines safely.
    }
  }
  return records;
}

function inspectTranscriptTail(records) {
  let lastPlannerPos = -1;
  let lastStepIdx = 0;
  let ctxTokens = 0;

  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r.type !== "PLANNER_RESPONSE") continue;
    const inTok = Number(r.input_tokens || 0);
    const cacheTok = Number(r.cache_read_tokens || 0);
    if (inTok + cacheTok <= 0) continue;
    lastPlannerPos = i;
    lastStepIdx = Number.isFinite(Number(r.step_index)) ? Number(r.step_index) : i;
    ctxTokens = inTok + cacheTok;
    break;
  }

  if (lastPlannerPos < 0) return null;

  const hasTrailingCheckpoint = records
    .slice(lastPlannerPos + 1)
    .some((r) => r.type === "CHECKPOINT");

  return { lastStepIdx, ctxTokens, hasTrailingCheckpoint };
}

function readStateMap(statePath) {
  if (!existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStateMap(statePath, stateMap) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(stateMap, null, 2) + "\n", "utf8");
}

/**
 * Evaluate Stop hook payload and save a 0-LLM snapshot when session is truly idle and heavy.
 * Always resolves to `{}` so the model is never awakened or blocked.
 */
export async function evaluateStopIdle(payload = {}, env = process.env) {
  try {
    if (String(env?.SAVE_TOKEN_IDLE_SNAPSHOT_MODE || "").trim().toLowerCase() === "off") {
      return {};
    }

    if (
      payload?.terminationReason !== "NO_TOOL_CALL" ||
      payload?.fullyIdle !== true ||
      payload?.continuationActive === true
    ) {
      return {};
    }

    const transcriptPath = resolveTranscriptPath(payload);
    if (!transcriptPath) return {};

    const records = readTailRecords(transcriptPath);
    const tailInfo = inspectTranscriptTail(records);
    if (!tailInfo || tailInfo.hasTrailingCheckpoint) return {};

    const threshold = Math.max(10000, Number(env?.SAVE_TOKEN_IDLE_THRESHOLD) || 100000);
    if (tailInfo.ctxTokens < threshold) return {};

    const dbPath = resolveDbPath(env);
    const pluginDir = dirname(dbPath);
    const statePath = join(pluginDir, "idle-snapshot-state.json");
    const convId =
      String(payload?.conversationId || payload?.conversation_id || "").trim() ||
      ( /[\\/]\.system_generated[\\/]logs[\\/]/i.test(transcriptPath)
        ? basename(dirname(dirname(dirname(transcriptPath))))
        : basename(transcriptPath, ".jsonl") ) ||
      "session";

    const now = Number.isFinite(Number(payload?.nowMs)) ? Number(payload.nowMs) : Date.now();
    const stateMap = readStateMap(statePath);
    const prev = stateMap[convId];
    if (
      prev &&
      (prev.stepIndex === tailInfo.lastStepIdx ||
        (tailInfo.lastStepIdx - prev.stepIndex < DEDUP_STEP_GAP &&
          now - Number(prev.timestampMs || 0) < DEDUP_WINDOW_MS))
    ) {
      return {};
    }

    const distillDir = env?.SAVE_TOKEN_DISTILL_DIR?.trim() || join(pluginDir, "distilled");
    const distilled = await distillTranscriptFile(transcriptPath, {
      conversationId: convId,
      maxChars: 3400,
      cacheDir: distillDir,
    });

    const workspaceHint =
      distilled.workspace ||
      String(payload?.cwd || "").trim() ||
      (Array.isArray(payload?.workspacePaths) ? String(payload.workspacePaths[0] || "").trim() : "");

    const branchInfo = inferBranch({
      workspace: workspaceHint,
      project: workspaceHint,
      title: distilled.title,
      firstUserPrompt: distilled.firstUserPrompt,
      touchedFiles: distilled.touchedFiles,
    });
    const tagInfo = inferTags({
      explicitTags: ["idle-auto"],
      touchedFiles: distilled.touchedFiles,
      title: distilled.title,
      firstUserPrompt: distilled.firstUserPrompt,
      recentErrors: distilled.recentErrors,
    });

    const store = createHandoffStore({
      dbPath,
      handoffDir: join(pluginDir, "handoffs"),
      progressDir: join(pluginDir, "progress"),
    });
    try {
      store.saveHandoff({
        conversationId: convId,
        title: distilled.title,
        project: workspaceHint,
        branch: branchInfo.branch,
        tags: tagInfo.tags,
        summaryMd: distilled.summaryMd,
        sourceSig: distilled.sourceSig,
        touchedFiles: distilled.touchedFiles,
      });
    } finally {
      store.close();
    }

    stateMap[convId] = {
      stepIndex: tailInfo.lastStepIdx,
      timestampMs: now,
      ctxTokens: tailInfo.ctxTokens,
    };
    writeStateMap(statePath, stateMap);
    return {};
  } catch {
    return {};
  }
}

async function main() {
  const payload = await readStdinSafe();
  await evaluateStopIdle(payload, process.env);
  process.stdout.write("{}\n");
}

const isEntry =
  process.argv[1] &&
  toPosix(resolve(process.argv[1])).toLowerCase() === toPosix(resolve(fileURLToPath(import.meta.url))).toLowerCase();

if (isEntry) {
  main().catch(() => {
    process.stdout.write("{}\n");
    process.exit(0);
  });
}
