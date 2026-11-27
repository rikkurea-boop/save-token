// A local observation window, never a server expiry or a cache-validity claim.
export function cacheObservation(requests = [], now = Date.now()) {
  const latest=requests.filter(r=>Number.isFinite(r.timestampMs)&&r.timestampMs>0&&r.inputTokens+r.cacheReadTokens>0&&!r.error).reduce((last,r)=>!last||r.timestampMs>last.timestampMs?r:last,null);
  if(!latest)return null;
  const ageMs=now-latest.timestampMs;
  if(ageMs<0)return null;
  const total=latest.inputTokens+latest.cacheReadTokens;
  const windowMs=/gemini|claude/i.test(latest.model||'')?300000:null;
  return{model:latest.model,lastRequestAtMs:latest.timestampMs,ageMs,
    hitPercent:Math.round(latest.cacheReadTokens/total*1000)/10,
    assumedWindowMs:windowMs,remainingMs:windowMs==null?null:Math.max(0,windowMs-ageMs),
    serverExpiresAtMs:null,estimated:true};
}
