// Compare usage and capacity from the same generation. Local tokenizer estimates
// can differ substantially from provider tokenization, particularly for tools.
export function contextSnapshot(generation, fallbackTokens = 0, latestCheckpoint = null) {
  const metadata = generation?.context;
  const reportedMaxTokens = metadata?.maxTokens > 0 ? metadata.maxTokens : null;
  const actual = generation?.providerInputTokens;
  const hasActual = Number.isFinite(actual) && actual > 0;
  const estimatedUsedTokens = metadata?.usedTokens ?? null;
  const baseUsedTokens = hasActual ? actual : Math.max(0, estimatedUsedTokens ?? fallbackTokens);
  const rawGroups = (metadata?.categories || []).flatMap(group => {
    const skills = group.label === 'System Prompt' && group.children?.find(child => child.label === 'skills');
    return skills ? [{ ...group, tokens: Math.max(0, group.tokens - skills.tokens) }, { key: 'skills', label: 'Skills', tokens: skills.tokens, tone: 'active' }] : [group];
  }).filter(group => Number.isFinite(group.tokens) && group.tokens > 0);

  const genMaxStep = Array.isArray(generation?.stepIndices) && generation.stepIndices.length
    ? Math.max(...generation.stepIndices)
    : -1;
  const isPostCompact = Boolean(
    latestCheckpoint &&
    Number.isFinite(latestCheckpoint.stepIndex) &&
    latestCheckpoint.stepIndex > genMaxStep &&
    genMaxStep >= 0 &&
    baseUsedTokens > 0
  );

  let usedTokens = baseUsedTokens;
  let groups = rawGroups;
  let compactedPending = false;
  let preCompactUsedTokens = null;
  let preCompactPercent = null;

  if (isPostCompact) {
    const summaryEst = Number(latestCheckpoint.summaryTokens) > 0
      ? Number(latestCheckpoint.summaryTokens)
      : Math.min(Math.round(baseUsedTokens * 0.12), 12000);
    const nonMessages = rawGroups.filter(g => !/^(?:chat\s+)?messages$/i.test(String(g.label || '')));
    const fixedTokens = nonMessages.length
      ? nonMessages.reduce((sum, g) => sum + Math.max(0, g.tokens), 0)
      : Math.min(Math.round(baseUsedTokens * 0.12), 18000);
    const estTotal = fixedTokens + summaryEst;
    if (estTotal < baseUsedTokens) {
      compactedPending = true;
      preCompactUsedTokens = baseUsedTokens;
      const baseMax = reportedMaxTokens != null && baseUsedTokens <= reportedMaxTokens ? reportedMaxTokens : null;
      preCompactPercent = baseMax ? Number((baseUsedTokens / baseMax * 100).toFixed(1)) : null;
      usedTokens = estTotal;
      if (nonMessages.length) {
        groups = [...nonMessages, { key: 'messages-compacted', label: 'Chat Messages', tokens: summaryEst, tone: 'active' }];
      } else {
        groups = [];
      }
    }
  }

  // An inconsistent capacity cannot support an honest utilization percentage.
  const maxTokens = reportedMaxTokens != null && usedTokens <= reportedMaxTokens ? reportedMaxTokens : null;
  const percent = tokens => maxTokens ? Number((tokens / maxTokens * 100).toFixed(1)) : null;
  const total = groups.reduce((sum, group) => sum + Math.max(0, group.tokens), 0);
  // The provider supplies only the total. Category counts remain estimates and
  // are labeled as such in the UI. Largest remainders preserve the exact total.
  const apportioned = groups.map(group => total ? usedTokens * Math.max(0, group.tokens) / total : 0);
  const counts = apportioned.map(Math.floor);
  const order = apportioned.map((value, index) => ({ index, remainder: value - counts[index] })).sort((a, b) => b.remainder - a.remainder);
  if (total) for (let i = 0, remaining = usedTokens - counts.reduce((a, b) => a + b, 0); i < remaining; i++) counts[order[i % order.length].index]++;
  const categories = groups.map((group, index) => ({ ...group, reportedTokens: group.tokens, tokens: total ? counts[index] : group.tokens, estimated: true, percent: percent(total ? counts[index] : group.tokens) }));
  if (!categories.length && usedTokens > 0) categories.push({ key: 'input', label: '输入上下文', tokens: usedTokens, estimated: !hasActual || compactedPending, percent: percent(usedTokens), tone: 'active' });
  const freeTokens = maxTokens == null ? null : maxTokens - usedTokens;
  if (freeTokens != null) categories.push({ key: 'free', label: '剩余空间', tokens: freeTokens, percent: percent(freeTokens), tone: 'free' });
  return {
    usedTokens, maxTokens, reportedMaxTokens, estimatedUsedTokens,
    usedPercent: percent(usedTokens), freePercent: freeTokens == null ? null : percent(freeTokens),
    categories,
    compactedPending,
    preCompactUsedTokens,
    preCompactPercent,
    source: compactedPending ? 'post-compact-estimate' : hasActual ? 'provider-usage' : metadata ? 'client-estimate' : 'transcript'
  };
}

export function shortModelName(name) {
  const clean = String(name || '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (!clean) return 'Unknown';
  const g4 = clean.match(/^gemini[\s-]+4[\s-]+([a-z0-9]+)/i);
  if (g4) return g4[1].charAt(0).toUpperCase() + g4[1].slice(1).toLowerCase();
  const gVer = clean.match(/^gemini[\s-]+(\d+(?:\.\d+)?)[\s-]+(pro|flash)/i);
  if (gVer) return `${gVer[1]} ${gVer[2].charAt(0).toUpperCase()}${gVer[2].slice(1).toLowerCase()}`;
  return clean.replace(/-(?:high|xhigh|medium|low|trial|n)$/i, '');
}

export function modelContexts(generations = [], checkpointSteps = [], postCompactSnapshot = null) {
  const valid = (generations || []).filter(g => g?.modelName && ((Number.isFinite(g.providerInputTokens) && g.providerInputTokens > 0) || (g.context?.usedTokens > 0)));
  const knownExecutionEnum = valid.find(g => g.executionModelEnum)?.executionModelEnum || null;
  const hasOrchestrator = Boolean(knownExecutionEnum) || valid.some(g => g.role === 'execution' || g.role === 'planner' || /orchestrator/i.test(g.modelName || ''));
  const map = new Map();
  let lastKey = '';
  for (const g of valid) {
    const used = Number.isFinite(g.providerInputTokens) && g.providerInputTokens > 0 ? g.providerInputTokens : g.context.usedTokens;
    const rawMax = g.context?.maxTokens > 0 ? g.context.maxTokens : null;
    const maxTokens = rawMax != null && used <= rawMax ? rawMax : null;
    const inferredRole = g.role || (knownExecutionEnum && g.modelEnum ? (g.modelEnum === knownExecutionEnum ? 'execution' : 'planner') : '');
    const role = hasOrchestrator ? (inferredRole || 'planner') : '';
    const shortName = shortModelName(g.modelName);
    const key = `${role}:${shortName.toLowerCase()}`;
    const prev = map.get(key);
    let compactions = prev?.compactions || 0;
    if (prev && prev.usedTokens > 0 && used < prev.usedTokens * 0.72 && prev.usedTokens - used > 30000) compactions++;
    const resolvedMax = maxTokens ?? prev?.maxTokens ?? null;
    const usedPercent = resolvedMax ? Number((used / resolvedMax * 100).toFixed(1)) : null;
    map.set(key, {
      key,
      role,
      shortName,
      fullName: g.modelName,
      usedTokens: used,
      maxTokens: resolvedMax,
      usedPercent,
      compactions,
      isCurrent: false
    });
    lastKey = key;
  }
  const models = [...map.values()].map(entry => {
    const isCurrent = entry.key === lastKey;
    if (isCurrent && postCompactSnapshot?.compactedPending && postCompactSnapshot.usedTokens > 0) {
      const resolvedMax = postCompactSnapshot.maxTokens ?? entry.maxTokens;
      return {
        ...entry,
        isCurrent,
        usedTokens: postCompactSnapshot.usedTokens,
        maxTokens: resolvedMax,
        usedPercent: resolvedMax ? Number((postCompactSnapshot.usedTokens / resolvedMax * 100).toFixed(1)) : entry.usedPercent
      };
    }
    return { ...entry, isCurrent };
  });
  const detectedCompactions = models.reduce((sum, entry) => sum + entry.compactions, 0);
  const compactions = Math.max(Array.isArray(checkpointSteps) ? checkpointSteps.length : 0, detectedCompactions);
  if (models.length === 1 && compactions > models[0].compactions) models[0].compactions = compactions;
  return { models, hasOrchestrator, compactions };
}
