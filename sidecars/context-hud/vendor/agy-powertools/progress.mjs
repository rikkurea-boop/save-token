import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function matchesTurnExecution(turn, execution, conversationId, steps = null) {
  if (!turn || !execution || !conversationId || execution.conversationId !== conversationId ||
      !Number.isInteger(execution.turnStartStepIndex) ||
      execution.turnStartStepIndex < turn.stepIndexStart) return false;
  if (execution.turnStartStepIndex === turn.stepIndexStart) return true;
  if (Number.isInteger(execution.userTurnStartStepIndex)) {
    return execution.userTurnStartStepIndex === turn.stepIndexStart;
  }
  if (execution.isSystemTurn === true) return true;
  if (Array.isArray(steps)) {
    const startStep = steps.find(s => s?.step_index === execution.turnStartStepIndex);
    if (startStep && startStep.type !== 'USER_INPUT') return true;
  }
  return false;
}

export function resolveTurnExecution(turn, execution, conversationId, steps = null) {
  if (!matchesTurnExecution(turn, execution, conversationId, steps)) return turn;
  // An ERROR_MESSAGE can be a retried request. Only native lifecycle state
  // tells us whether the whole invocation has actually stopped.
  const hasActiveChildren = Boolean(
    (Array.isArray(execution.activeSubagents) && execution.activeSubagents.length > 0) ||
    execution.notFullyIdle === true
  );
  let status;
  if (execution.status === 2 || execution.status === 4) status = 'running';
  else if (execution.status === 3) status = 'canceling';
  else if (execution.status === 1) {
    const reason = execution.terminationReason;
    if (reason === 2) status = 'stopped';
    else if ([1, 3, 6, 11].includes(reason)) status = 'error';
    else if (hasActiveChildren) status = 'running';
    else if ([4, 8, 10].includes(reason)) status = 'complete';
    else status = turn.status === 'running' || turn.status === 'canceling' ? 'stopped' : turn.status;
  }
  if (!status) return turn;
  return {...turn, status, ...(['running', 'canceling'].includes(status) ? {completedAtMs: null} : {})};
}

export function parseChecklist(markdown) {
  const lines = String(markdown).split('\n');
  const matches = lines.flatMap((line, index) => {
    const match = line.match(/^(\s*)[-*+]\s+\[([ xX/\-])\]\s+(.+)/);
    return match ? [{ index, depth: match[1].length, status: /x/i.test(match[2]) ? 'complete' : /[/\-]/.test(match[2]) ? 'running' : 'pending', title: match[3].replace(/\*\*|`/g, '').trim() }] : [];
  });
  // Count leaf tasks so a parent and its children do not count the same work twice.
  return matches.filter((task, index) => !matches[index + 1] || matches[index + 1].depth <= task.depth).map(({ title, status }) => ({ title, status }));
}

export function classifyRetryReason(raw = '') {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (/unexpected\s+eof|\beof\b|connection\s+reset|broken\s+pipe/i.test(text)) {
    return { code: 'eof', zh: '网络连接中断 (EOF)', en: 'Connection dropped (EOF)' };
  }
  if (/context\s+deadline\s+exceeded|timeout|timed\s*out/i.test(text)) {
    return { code: 'timeout', zh: '请求超时', en: 'Request timeout' };
  }
  if (/\b429\b|resource_exhausted|rate\s*limit|too\s+many\s+requests|quota/i.test(text)) {
    return { code: 'rate-limit', zh: '限流或配额不足 (429)', en: 'Rate limited or quota (429)' };
  }
  if (/\b503\b|\b502\b|\b504\b|unavailable|overloaded|capacity|high\s+demand/i.test(text)) {
    return { code: 'unavailable', zh: '上游服务繁忙 (503)', en: 'Upstream busy (503)' };
  }
  if (/\b403\b|region|location|country|not\s+available\s+in\s+your|unsupported/i.test(text)) {
    return { code: 'region', zh: '地区或权限受限', en: 'Region or access restricted' };
  }
  if (/econnrefused|proxy|tls|handshake|dns|no\s+such\s+host|network/i.test(text)) {
    return { code: 'connection', zh: '代理或网络连接异常', en: 'Proxy or network error' };
  }
  const compact = text.slice(0, 60);
  return { code: 'other', zh: compact, en: compact };
}

function friendlyToolLabel(name = '') {
  const n = String(name || '').trim();
  if (!n) return '';
  const map = {
    run_command: 'run_command',
    read_file: 'read_file',
    write_file: 'write_file',
    edit_file: 'edit_file',
    search_web: 'search_web',
    invoke_subagent: 'invoke_subagent'
  };
  return map[n] || n;
}

export function readProgress(appDataDir, conversationId, turns, steps, now = Date.now(), database = null, execution = null) {
  const latest = turns.at(-1);
  let tasks = [], updatedAtMs = null, source = '';
  try {
    const path = join(appDataDir, 'brain', conversationId, 'task.md');
    updatedAtMs = statSync(path).mtimeMs;
    tasks = parseChecklist(readFileSync(path, 'utf8')); source = 'task.md';
  } catch { /* No task artifact has been written. */ }
  const boundaries = steps.filter(s => latest && s.step_index >= latest.stepIndexStart).flatMap(s => (s.tool_calls || []).filter(c => /task_boundary$/.test(c.name)).map(c => ({ ...c.args, stepIndex: s.step_index })));
  const boundary = boundaries.at(-1);
  const recentCalls = latest?.toolCalls || [];
  const recentActivity = recentCalls.slice(-4).map(call => {
    const startedAtMs = Date.parse(call.startedAtIso), completedAtMs = Date.parse(call.completedAtIso);
    return { id:call.id, label:call.itemLabel, detail:call.detailTitle, groupKey:call.groupKey,
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
      status:Number.isFinite(completedAtMs)?'complete':latest?.status==='running'&&Number.isFinite(startedAtMs)?'running':'recorded',
      durationMs:call.durationMs ?? null };
  });
  const active = recentActivity.find(call => call.status === 'running');
  const end = ['running','canceling'].includes(latest?.status) ? now : latest?.completedAtMs;
  const elapsedMs = Number.isFinite(latest?.startedAtMs)&&Number.isFinite(end)?Math.max(0,end-latest.startedAtMs):null;
  const completed = tasks.filter(t => t.status === 'complete').length;

  let phase = '', phaseDetail = '', phaseElapsedMs = null, retryCount = 0, retryError = '', retrySummary = null, activeSubagentCount = 0;
  if (latest?.status === 'running') {
    const turnSteps = steps.filter(s => s.step_index >= latest.stepIndexStart);
    const lastStep = turnSteps.at(-1);
    const turnErrorSteps = turnSteps.filter(s => s.type === 'ERROR_MESSAGE');
    const turnGens = (database?.generations || []).filter(g =>
      Array.isArray(g.stepIndices) && g.stepIndices.some(idx => idx >= latest.stepIndexStart)
    );
    const lastGen = turnGens.at(-1);
    const lastGenMaxStep = lastGen?.stepIndices?.length ? Math.max(...lastGen.stepIndices) : -1;
    const hasFinishedPlannerAfterGen = lastStep?.type === 'PLANNER_RESPONSE' && lastStep.step_index > lastGenMaxStep && Boolean(lastStep.content);
    const genHasRetry = Boolean(lastGen && !hasFinishedPlannerAfterGen && ((lastGen.retries || 0) > 0 || (lastGen.retryErrors?.length || 0) > 0 || lastGen.error));
    const matchedExec = matchesTurnExecution(latest, execution, conversationId, steps)
      ? execution
      : null;
    const live = matchedExec?.live && typeof matchedExec.live === 'object' ? matchedExec.live : null;
    const activeSubagents = Array.isArray(matchedExec?.activeSubagents) ? matchedExec.activeSubagents : [];

    const lastTiming = lastStep ? database?.times?.get(lastStep.step_index) : null;
    const lastToolEnd = recentCalls.map(c => Date.parse(c.completedAtIso)).filter(Number.isFinite).at(-1);
    const lastStepMs = lastTiming?.completedMs ?? lastTiming?.finishedMs ?? lastTiming?.createdMs ?? (lastStep?.created_at ? Date.parse(lastStep.created_at) : null);
    const waitSinceMs = Math.max(...[latest.startedAtMs, lastToolEnd, lastStepMs].filter(Number.isFinite));

    if (matchedExec?.status === 1 && activeSubagents.length > 0) {
      phase = 'subagent';
      activeSubagentCount = activeSubagents.length;
      phaseDetail = activeSubagents.length === 1 ? String(activeSubagents[0]?.title || '').trim() : String(activeSubagents.length);
      if (Number.isFinite(waitSinceMs)) phaseElapsedMs = Math.max(0, now - waitSinceMs);
    } else if (matchedExec?.status === 1 && matchedExec.notFullyIdle === true) {
      phase = 'background';
      if (Number.isFinite(waitSinceMs)) phaseElapsedMs = Math.max(0, now - waitSinceMs);
    } else if (live?.waiting) {
      phase = 'waiting';
      phaseDetail = friendlyToolLabel(live.toolName || active?.label || '');
      if (Number.isFinite(waitSinceMs)) phaseElapsedMs = Math.max(0, now - waitSinceMs);
    } else if (live && live.lastCase !== 'plannerResponse' && live.lastCase !== 'userInput' && live.lastCase !== 'errorMessage' && live.lastStatus === 2 && live.toolName) {
      phase = 'tool';
      phaseDetail = (active && active.label) || friendlyToolLabel(live.toolName);
      if (Number.isFinite(active?.startedAtMs)) phaseElapsedMs = Math.max(0, now - active.startedAtMs);
      else if (Number.isFinite(waitSinceMs)) phaseElapsedMs = Math.max(0, now - waitSinceMs);
    } else if (active && !live) {
      phase = 'tool';
      phaseDetail = active.label || '';
      if (Number.isFinite(active.startedAtMs)) phaseElapsedMs = Math.max(0, now - active.startedAtMs);
    } else if (live?.lastCase === 'plannerResponse' && live.hasResponse && live.toolCallCount === 0) {
      phase = 'streaming';
      if (Number.isFinite(waitSinceMs)) phaseElapsedMs = Math.max(0, now - waitSinceMs);
    } else if (live?.lastCase === 'errorMessage' || live?.genError || (!live && (lastStep?.type === 'ERROR_MESSAGE' || genHasRetry)) || (live && !live.hasThinking && !live.hasResponse && (lastStep?.type === 'ERROR_MESSAGE' || genHasRetry))) {
      phase = 'retrying';
      const genRetries = Number(lastGen?.retries || 0);
      const genErrs = Array.isArray(lastGen?.retryErrors) ? lastGen.retryErrors.filter(Boolean) : [];
      retryCount = Math.max(turnErrorSteps.length, genRetries, genErrs.length, 1);
      retryError = String(
        live?.errorText ||
        live?.genError ||
        (lastStep?.type === 'ERROR_MESSAGE' && lastStep.content) ||
        genErrs.at(-1) ||
        lastGen?.error ||
        turnErrorSteps.at(-1)?.content ||
        ''
      ).trim();
      retrySummary = classifyRetryReason(retryError);
      const errTiming = lastStep ? database?.times?.get(lastStep.step_index) : null;
      const sinceMs = errTiming?.createdMs ?? (lastStep?.created_at ? Date.parse(lastStep.created_at) : null) ?? latest.startedAtMs;
      if (Number.isFinite(sinceMs)) phaseElapsedMs = Math.max(0, now - sinceMs);
    } else if (live?.lastCase === 'plannerResponse' && live.hasThinking && !live.hasResponse) {
      phase = 'thinking';
      phaseDetail = 'thinking';
      if (Number.isFinite(waitSinceMs)) phaseElapsedMs = Math.max(0, now - waitSinceMs);
    } else if (active) {
      phase = 'tool';
      phaseDetail = active.label || '';
      if (Number.isFinite(active.startedAtMs)) phaseElapsedMs = Math.max(0, now - active.startedAtMs);
    } else {
      const isStreaming = !live && lastStep?.type === 'PLANNER_RESPONSE'
        && !(lastStep.tool_calls?.length)
        && (Number.isFinite(lastTiming?.viewableMs) || Boolean(lastStep.content))
        && !Number.isFinite(lastTiming?.finishedMs);
      if (isStreaming) {
        phase = 'streaming';
        const sinceMs = lastTiming?.viewableMs ?? lastTiming?.createdMs ?? latest.startedAtMs;
        if (Number.isFinite(sinceMs)) phaseElapsedMs = Math.max(0, now - sinceMs);
      } else {
        phase = 'thinking';
        phaseDetail = live ? 'waiting-model' : '';
        if (Number.isFinite(waitSinceMs)) phaseElapsedMs = Math.max(0, now - waitSinceMs);
      }
    }
  }

  return {
    tasks, completed, total: tasks.length, percent: tasks.length ? Math.round(completed / tasks.length * 100) : null,
    title: boundary?.TaskName || '', current: boundary?.TaskStatus || active?.label || '',
    status: latest?.status || 'idle', source, updatedAtMs, startedAtMs: latest?.startedAtMs || null,
    toolCount: recentCalls.length,
    recentActivity: recentActivity.map(({ startedAtMs: _s, ...rest }) => rest),
    elapsedMs,
    phase, phaseDetail, phaseElapsedMs, retryCount, retryError, retrySummary, activeSubagentCount,
    stale: !!(latest?.startedAtMs && updatedAtMs && updatedAtMs < latest.startedAtMs)
  };
}
