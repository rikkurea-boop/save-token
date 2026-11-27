import { estimateCost } from './pricing.mjs';

const GENERIC_GEMINI_TIERS = new Set(['flash', 'pro', 'ultra', 'nano', 'lite', 'mini', 'exp', 'thinking']);

export function shortSubagentModel(label = '') {
  const raw = String(label || '').trim();
  if (!raw || raw === '未知模型') return '';
  const stripped = raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (/orchestrator/i.test(stripped)) return stripped.replace(/^gemini[-\s]*pro[-\s]*/i, '').trim() || 'Orchestrator';
  const gemini = stripped.match(/gemini[\s-]*(\d+(?:\.\d+)?)[\s-]+([a-z0-9]+)(?:[\s-]+([a-z0-9]+))?/i);
  if (gemini) {
    const ver = gemini[1];
    const name = gemini[2];
    const lower = name.toLowerCase();
    const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
    if (!GENERIC_GEMINI_TIERS.has(lower)) return cap;
    const extra = gemini[3] && !/^(low|medium|high|xhigh|max|minimal|thinking|preview|exp)$/i.test(gemini[3])
      ? ` ${gemini[3].charAt(0).toUpperCase() + gemini[3].slice(1).toLowerCase()}`
      : '';
    return `${ver} ${cap}${extra}`;
  }
  const claude = stripped.match(/claude[\s-]+(opus|sonnet|haiku)(?:[\s-]+([\d.]+))?/i);
  if (claude) {
    const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1).toLowerCase();
    return claude[2] ? `${family} ${claude[2]}` : family;
  }
  if (/^gpt[-\s]/i.test(stripped)) {
    return stripped.replace(/^gpt[-\s]+oss[-\s]+/i, 'GPT-OSS ').replace(/^gpt[-\s]+/i, 'GPT-').toUpperCase();
  }
  return stripped.length > 18 ? stripped.slice(0, 18) : stripped;
}

export function estimateRequestsCost(requests = [], rates = [], options = {}) {
  const list = Array.isArray(requests) ? requests : [];
  let costSum = 0, pricedCount = 0;
  for (const r of list) {
    const cost = estimateCost(r, rates, options);
    if (cost != null) {
      costSum += cost;
      pricedCount++;
    }
  }
  return pricedCount > 0 ? costSum : list.length === 0 ? 0 : null;
}

export function summarizeSubagentSession(parsed, rates = [], options = {}) {
  if (!parsed || !parsed.conversationId) return null;
  const requests = Array.isArray(parsed.requests) ? parsed.requests : [];
  const costUsd = estimateRequestsCost(requests, rates, options);
  const modelName = parsed.modelName && parsed.modelName !== '未知模型'
    ? parsed.modelName
    : (parsed.contextWindow?.models?.at(-1)?.fullName || '');
  return {
    conversationId: parsed.conversationId,
    modelName: modelName || '未知模型',
    shortModel: shortSubagentModel(modelName),
    contextWindow: parsed.contextWindow,
    telemetry: parsed.telemetry,
    costUsd
  };
}

export function aggregateSubagentTotals(entries = []) {
  let totalTokens = 0, inputTokens = 0, cacheReadTokens = 0, outputTokens = 0;
  let requestCount = 0, errorCount = 0, toolCount = 0;
  let costSum = 0, pricedCount = 0, count = 0;
  for (const item of entries) {
    const t = item?.telemetry;
    if (!t) continue;
    count++;
    totalTokens += Number(t.totalTokens) || 0;
    inputTokens += Number(t.inputTokens) || 0;
    cacheReadTokens += Number(t.cacheReadTokens) || 0;
    outputTokens += Number(t.outputTokens) || 0;
    requestCount += Number(t.requestCount) || 0;
    errorCount += Number(t.errorCount) || 0;
    toolCount += Number(t.toolCount) || 0;
    if (typeof item.costUsd === 'number' && Number.isFinite(item.costUsd)) {
      costSum += item.costUsd;
      pricedCount++;
    }
  }
  const totalIn = inputTokens + cacheReadTokens;
  return {
    count,
    totalTokens,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    cacheHitPercent: totalIn > 0 ? Number((cacheReadTokens / totalIn * 100).toFixed(1)) : null,
    requestCount,
    errorCount,
    toolCount,
    costUsd: pricedCount > 0 ? costSum : requestCount === 0 ? 0 : null
  };
}
