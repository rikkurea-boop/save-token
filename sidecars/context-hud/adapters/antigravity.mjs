/**
 * Streamlined Antigravity Context & Distill Adapter for Save Token HUD.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { usageDashboard } from '../vendor/agy-powertools/analytics.mjs';
import { shortModelName } from '../vendor/agy-powertools/context.mjs';
import { estimateCost } from '../vendor/agy-powertools/pricing.mjs';
import { listRecentConversations, parseSessionData } from '../vendor/agy-powertools/session-parser.mjs';

const execFileAsync = promisify(execFile);

export const CONV_ID_RE = /^[0-9a-f-]{8,}$/i;

const VI_LABELS = {
  '剩余空间': 'Còn trống',
  '输入上下文': 'Ngữ cảnh đầu vào',
  '未知模型': 'Không rõ model',
  '工具调用': 'Gọi công cụ',
  '命令': 'Lệnh',
  '文件读取': 'Đọc tệp',
  '文件修改': 'Sửa tệp',
  '搜索': 'Tìm kiếm',
};

function viLabel(raw, fallback = '') {
  const s = String(raw || '');
  return VI_LABELS[s] || (s || fallback);
}

function cleanTitle(raw, id) {
  const s = String(raw || '')
    .replace(/<(voice_instructions|talker_agent_context|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?USER_REQUEST>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || /^</.test(s)) return `Phiên ${String(id).slice(0, 8)}`;
  return s.length > 72 ? `${s.slice(0, 71)}…` : s;
}

function statStamp(filePath) {
  try {
    const s = statSync(filePath);
    return `${Math.trunc(s.mtimeMs)}:${s.size}`;
  } catch {
    return '0:0';
  }
}

export function createAntigravityAdapter({ appDataDir, pluginDataDir, pricingStore, distillScriptPath }) {
  const sessionPayloadCache = new Map();

  function readDbTitles() {
    const titles = new Map();
    const dbPath = join(appDataDir, 'conversation_summaries.db');
    if (!existsSync(dbPath)) return titles;
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      for (const row of db.prepare('SELECT conversation_id, title FROM conversation_summaries').all()) {
        if (row?.conversation_id && row?.title) titles.set(row.conversation_id, String(row.title));
      }
    } catch {
      // Fallback to session-parser extracted title if summary DB is locked/unavailable.
    } finally {
      try { db?.close(); } catch {}
    }
    return titles;
  }

  function listSessions() {
    const dbTitles = readDbTitles();
    return listRecentConversations({ appDataDir }).slice(0, 30).map((c) => ({
      conversationId: c.conversationId,
      title: cleanTitle(dbTitles.get(c.conversationId) || c.title, c.conversationId),
      updatedAtIso: c.updatedAtIso,
    }));
  }

  function resolveTranscriptFile(convId) {
    const logsDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
    const full = join(logsDir, 'transcript_full.jsonl');
    if (existsSync(full)) return full;
    const compact = join(logsDir, 'transcript.jsonl');
    if (existsSync(compact)) return compact;
    return '';
  }

  function buildTopTools(turns) {
    const byTool = new Map();
    for (const t of turns) {
      for (const tc of t.toolCalls || []) {
        const name = String(tc.toolName || tc.itemLabel || 'unknown');
        let entry = byTool.get(name);
        if (!entry) {
          entry = { toolName: name, calls: 0, totalDurationMs: 0, totalOutputBytes: 0 };
          byTool.set(name, entry);
        }
        entry.calls += 1;
        if (Number.isFinite(tc.durationMs) && tc.durationMs >= 0) {
          entry.totalDurationMs += tc.durationMs;
        }
        const outB = Number(tc.outputBytes) || Buffer.byteLength(String(tc.outputPreview || ''), 'utf8');
        entry.totalOutputBytes += outB;
      }
    }

    return [...byTool.values()]
      .map((e) => ({
        toolName: e.toolName,
        calls: e.calls,
        totalDurationMs: Math.round(e.totalDurationMs),
        totalOutputBytes: e.totalOutputBytes,
      }))
      .sort((a, b) => b.totalOutputBytes - a.totalOutputBytes || b.totalDurationMs - a.totalDurationMs || b.calls - a.calls)
      .slice(0, 8);
  }

  function buildHandoffAdvice(cw) {
    const usedTokens = Number(cw.usedTokens || 0);
    const maxTokens = cw.maxTokens ? Number(cw.maxTokens) : null;
    const usedPercent = Number(cw.usedPercent || 0);

    if (usedPercent >= 80 || (!maxTokens && usedTokens >= 800000)) {
      return {
        level: 'critical',
        recommended: true,
        message: 'Ngữ cảnh ≥ 80% — nên chạy Handoff 0-LLM ngay',
      };
    }
    if (usedPercent >= 70 || (!maxTokens && usedTokens >= 700000)) {
      return {
        level: 'warn',
        recommended: true,
        message: 'Ngữ cảnh 70–80% — nên chuẩn bị Handoff 0-LLM',
      };
    }
    if (cw.compactedPending) {
      return {
        level: 'warn',
        recommended: false,
        message: 'Đã có checkpoint nén đang chờ áp dụng',
      };
    }
    return {
      level: 'ok',
      recommended: false,
      message: 'Ngữ cảnh ổn định',
    };
  }

  function buildSwitchAdvice(cw) {
    const usedTokens = Number(cw.usedTokens || 0);
    if (cw.compactedPending) {
      return {
        level: 'ready',
        shouldCompactBeforeSwitch: false,
        estAfterCompactTokens: usedTokens,
        estAfterHandoffTokens: 19000,
        savedPercent: 0,
        reason: 'Đã có checkpoint nén — đổi model ngay chỉ nạp tóm tắt gọn',
      };
    }
    if (usedTokens >= 80000) {
      const estAfterCompactTokens = 24000;
      const estAfterHandoffTokens = 19000;
      const savedPercent = Math.max(0, Math.round((1 - estAfterCompactTokens / usedTokens) * 100));
      return {
        level: 'compact_first',
        shouldCompactBeforeSwitch: true,
        estAfterCompactTokens,
        estAfterHandoffTokens,
        savedPercent,
        reason: `Ngữ cảnh ~${Math.round(usedTokens / 1000)}k: chạy /compact trước khi đổi model giúp giảm ~${savedPercent}% input nguội (còn ~24k), hoặc Handoff 0-LLM (~19k).`,
      };
    }
    return {
      level: 'ok',
      shouldCompactBeforeSwitch: false,
      estAfterCompactTokens: usedTokens,
      estAfterHandoffTokens: 19000,
      savedPercent: 0,
      reason: 'Ngữ cảnh nhẹ — có thể đổi model trực tiếp',
    };
  }

  function buildCacheWarmth(requests, cw, now = Date.now()) {
    const ttlSeconds = Math.max(60, Number(process.env.SAVE_TOKEN_CACHE_TTL_SEC) || 300);
    const riskTokens = Number(cw?.usedTokens || 0);
    let lastTs = null;
    for (const r of requests || []) {
      const ts = Number(r?.timestampMs);
      if (Number.isFinite(ts) && ts > 0 && (lastTs == null || ts > lastTs)) {
        lastTs = ts;
      }
    }
    if (lastTs == null) {
      return {
        status: 'unknown',
        idleSeconds: null,
        ttlSeconds,
        remainingSeconds: null,
        riskTokens,
        label: 'Chưa rõ độ ấm cache',
      };
    }
    const idleSeconds = Math.max(0, Math.round((now - lastTs) / 1000));
    const remainingSeconds = Math.max(0, ttlSeconds - idleSeconds);
    const status =
      idleSeconds < Math.round(ttlSeconds * 0.6)
        ? 'warm'
        : idleSeconds < ttlSeconds
          ? 'cooling'
          : 'cold';
    const label =
      status === 'warm'
        ? `Cache ấm (~${Math.max(1, Math.ceil(remainingSeconds / 60))}p)`
        : status === 'cooling'
          ? `Sắp nguội (~${remainingSeconds}s)`
          : 'Cache nguội (nguy cơ nạp lại)';
    return {
      status,
      idleSeconds,
      ttlSeconds,
      remainingSeconds,
      riskTokens,
      label,
    };
  }

  function summarizeBurnWindow(requests, cutoffMs, rates) {
    let requestsCount = 0;
    let uncachedInputTokens = 0;
    let cacheReadTokens = 0;
    let outputTokens = 0;
    let thinkingTokens = 0;
    let coldSwitches = 0;
    let estimatedCostUsd = 0;
    let pricedCount = 0;
    const modelCounts = new Map();

    for (const r of requests) {
      const ts = Number(r?.timestampMs);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
      requestsCount += 1;
      const inTok = Math.max(0, Number(r.inputTokens || 0));
      const cacheTok = Math.max(0, Number(r.cacheReadTokens || 0));
      const outTok = Math.max(0, Number(r.outputTokens || 0));
      const thinkTok = Math.max(0, Number(r.thinkingTokens || 0));
      uncachedInputTokens += inTok;
      cacheReadTokens += cacheTok;
      outputTokens += outTok;
      thinkingTokens += thinkTok;

      const totalIn = inTok + cacheTok;
      const hitRatio = totalIn > 0 ? cacheTok / totalIn : 1;
      if (inTok >= 80000 && hitRatio < 0.2) {
        coldSwitches += 1;
      }

      const cost = estimateCost(r, rates);
      if (cost != null && Number.isFinite(cost)) {
        estimatedCostUsd += cost;
        pricedCount += 1;
      }

      const mName = shortModelName(r.model || '') || viLabel(r.model, 'Không rõ');
      modelCounts.set(mName, (modelCounts.get(mName) || 0) + 1);
    }

    const denom = uncachedInputTokens + cacheReadTokens;
    const cacheHitPercent = denom > 0 ? Number(((cacheReadTokens / denom) * 100).toFixed(1)) : null;
    let topModel = '';
    let topCount = 0;
    for (const [m, c] of modelCounts.entries()) {
      if (c > topCount) {
        topModel = m;
        topCount = c;
      }
    }

    const wIn = uncachedInputTokens;
    const wCache = Math.round(cacheReadTokens * 0.1);
    const wOut = (outputTokens + thinkingTokens) * 5;
    const weightedBurnTokens = wIn + wCache + wOut;
    const burnSplit = weightedBurnTokens > 0
      ? {
          uncachedInputSharePct: Number(((wIn / weightedBurnTokens) * 100).toFixed(1)),
          cacheReadSharePct: Number(((wCache / weightedBurnTokens) * 100).toFixed(1)),
          outputSharePct: Number(((wOut / weightedBurnTokens) * 100).toFixed(1)),
        }
      : { uncachedInputSharePct: 0, cacheReadSharePct: 0, outputSharePct: 0 };

    return {
      requests: requestsCount,
      uncachedInputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      cacheHitPercent,
      coldSwitches,
      estimatedCostUsd: pricedCount > 0 ? Number(estimatedCostUsd.toFixed(4)) : 0,
      topModel,
      weightedBurnTokens,
      burnSplit,
    };
  }

  function getQuotaBurn({ now = Date.now(), force = false } = {}) {
    const dash = usageDashboard(appDataDir, { includeCli: false, force });
    const requests = Array.isArray(dash?.requests) ? dash.requests : [];
    const rates = pricingStore.get().rates || [];
    return {
      window5h: summarizeBurnWindow(requests, now - 5 * 3600 * 1000, rates),
      window7d: summarizeBurnWindow(requests, now - 7 * 86400 * 1000, rates),
      updatedAtMs: dash?.updatedAtMs || now,
    };
  }

  function getSession(convId) {
    const stamp = [
      statStamp(join(appDataDir, 'brain', convId, '.system_generated', 'logs', 'transcript_full.jsonl')),
      statStamp(join(appDataDir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl')),
      statStamp(join(appDataDir, 'conversations', `${convId}.db`)),
      statStamp(join(appDataDir, 'conversations', `${convId}.db-wal`)),
    ].join('|');

    const hit = sessionPayloadCache.get(convId);
    if (hit && hit.stamp === stamp) {
      return {
        ...hit.payload,
        cacheWarmth: buildCacheWarmth(hit.payload.recentRequests, hit.payload.contextWindow),
      };
    }

    const data = parseSessionData(convId, { includeSessions: false, appDataDir });
    const requests = Array.isArray(data.requests) ? data.requests : [];
    const turns = Array.isArray(data.turns) ? data.turns : [];
    const rates = pricingStore.get().rates || [];

    let estimatedCostUsd = 0;
    let pricedCount = 0;
    for (const r of requests) {
      const c = estimateCost(r, rates);
      if (c != null && Number.isFinite(c)) {
        estimatedCostUsd += c;
        pricedCount += 1;
      }
    }

    const cwRaw = data.contextWindow || {};
    const cw = {
      ...cwRaw,
      categories: Array.isArray(cwRaw.categories)
        ? cwRaw.categories.map((c) => ({ ...c, label: viLabel(c.label, c.key) }))
        : [],
    };

    const recentRequests = requests.slice(-20).reverse().map((r) => ({
      stepIndex: r.stepIndex,
      timestampMs: r.timestampMs,
      model: r.model,
      shortModel: shortModelName(r.model || '') || viLabel(r.model, ''),
      role: r.role,
      inputTokens: r.inputTokens || 0,
      cacheReadTokens: r.cacheReadTokens || 0,
      outputTokens: r.outputTokens || 0,
      totalInputTokens: (r.inputTokens || 0) + (r.cacheReadTokens || 0),
      cacheHitPercent: r.cacheHitPercent,
      tps: r.tps,
      durationMs: r.durationMs,
      status: r.status,
    }));

    const payload = {
      provider: 'antigravity',
      conversationId: data.conversationId,
      modelName: viLabel(data.modelName, 'Không rõ model'),
      contextWindow: cw,
      telemetry: data.telemetry || {},
      estimatedCostUsd: pricedCount > 0 ? Number(estimatedCostUsd.toFixed(4)) : null,
      handoffAdvice: buildHandoffAdvice(cw),
      switchAdvice: buildSwitchAdvice(cw),
      cacheWarmth: buildCacheWarmth(requests, cw),
      recentRequests,
      topTools: buildTopTools(turns),
    };

    sessionPayloadCache.set(convId, { stamp, payload });
    if (sessionPayloadCache.size > 20) {
      sessionPayloadCache.delete(sessionPayloadCache.keys().next().value);
    }
    return payload;
  }

  function getWatchTargets(convId) {
    const targets = [];
    if (convId && CONV_ID_RE.test(convId)) {
      const logsDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
      if (existsSync(logsDir)) {
        targets.push({ dir: logsDir, match: (f) => /^transcript.*\.jsonl$/i.test(f) });
      }
      const convDir = join(appDataDir, 'conversations');
      if (existsSync(convDir)) {
        targets.push({ dir: convDir, match: (f) => f.toLowerCase().startsWith(convId.toLowerCase()) });
      }
    }
    return targets;
  }

  async function createDistilledSummary({ conversationId, maxChars = 3800 }) {
    if (!conversationId || !CONV_ID_RE.test(conversationId)) {
      const err = new Error('invalid_conversation_id');
      err.code = 'INVALID_CONVERSATION_ID';
      throw err;
    }
    const transcriptFile = resolveTranscriptFile(conversationId);
    if (!transcriptFile) {
      const err = new Error('conversation_not_found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const st = statSync(transcriptFile);
    const clampedChars = Math.min(8000, Math.max(800, Math.trunc(Number(maxChars) || 3800)));
    const sourceSig = `<!-- source-sig:${Math.trunc(st.mtimeMs)}:${st.size}:${clampedChars} -->`;

    const { stdout } = await execFileAsync(
      process.execPath,
      ['--no-warnings=ExperimentalWarning', distillScriptPath, conversationId, '--max-chars', String(clampedChars), '--no-cache'],
      {
        env: {
          ...process.env,
          ANTIGRAVITY_BRAIN_DIR: join(appDataDir, 'brain'),
          SAVE_TOKEN_DISTILL_DIR: join(pluginDataDir, 'distilled'),
        },
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      }
    );

    const summaryMd = String(stdout || '').trim();
    const dbTitles = readDbTitles();
    const projectMatch = summaryMd.match(/^- Project:\s*(.+)$/m);
    const titleMatch = summaryMd.match(/^# Handoff:\s*(.+)$/m);
    const project = projectMatch ? projectMatch[1].trim() : '';
    const title = dbTitles.get(conversationId)
      ? cleanTitle(dbTitles.get(conversationId), conversationId)
      : cleanTitle(titleMatch ? titleMatch[1].trim() : '', conversationId);

    return {
      conversationId,
      title,
      project,
      summaryMd,
      sourceSig,
    };
  }

  return {
    provider: 'antigravity',
    listSessions,
    getSession,
    getQuotaBurn,
    getWatchTargets,
    createDistilledSummary,
  };
}
