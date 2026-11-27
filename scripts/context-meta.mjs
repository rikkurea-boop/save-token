import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "head"]);

const STOPWORDS = new Set([
  "toi", "can", "ban", "hay", "giup", "cho", "cua", "trong", "cac", "nhung", "nay", "kia",
  "la", "va", "de", "co", "khong", "duoc", "da", "se", "dang", "muon", "lam", "ve", "voi",
  "mot", "hai", "ba", "cai", "nay", "no", "nhu", "the", "nao", "sao", "thi", "ma", "neu",
  "update", "context", "please", "help", "make", "fix", "add", "check", "create", "build",
  "with", "from", "into", "this", "that", "these", "those", "have", "need", "want", "will",
  "for", "and", "the", "are", "was", "were", "can", "could", "should", "would", "about",
]);

const NOISE_SEGMENTS = new Set([
  "", ".", "..", "c:", "d:", "e:", "users", "admin", "home", "root", "var", "tmp", "temp",
  "scratch", "config", "plugins", "plugin_data", "antigravity", ".gemini", ".agents", ".claude",
  ".codex", "src", "lib", "dist", "build", "out", "node_modules", ".system_generated", "logs",
  "brain", "artifacts", "browser_sandbox", "public", "vendor",
]);

const MODULE_TAG_HINTS = new Set([
  "hud", "mcp", "hooks", "hook", "scripts", "server", "sidecars", "skills", "rules",
  "installer", "install", "tests", "test", "ui", "api", "db", "auth", "cli", "docs",
  "adapters", "cache", "store", "handoff", "distill", "outline", "compact", "browser",
]);

const KEYWORD_TAG_RULES = [
  [/\bhud\b|sidecar/i, "hud"],
  [/\bmcp\b/i, "mcp"],
  [/\bhooks?\b|pretooluse|sessionstart/i, "hooks"],
  [/\bcache\b|cachehit|prompt.?cache/i, "cache"],
  [/\btoken\b|save.?token|compact/i, "token"],
  [/\bhandoff\b|resume|distill/i, "handoff"],
  [/\boutline\b|\bast\b|readsymbol|symbol/i, "outline"],
  [/\btests?\b|vitest|jest|pytest|assert/i, "test"],
  [/\bbugfix\b|\bfix\b|\bloi\b|\berror\b|debug/i, "bugfix"],
  [/\brefactor\b|toi uu|nang cap|cai tien/i, "refactor"],
  [/\bperf\b|latency|speed|nhanh/i, "perf"],
  [/\bsecurity\b|bao mat|guard|path.?traversal/i, "security"],
  [/\bui\b|html|css|layout|theme/i, "ui"],
  [/\bapi\b|http|sse|endpoint|route/i, "api"],
  [/\bdb\b|sqlite|fts5|sql/i, "db"],
  [/\bcli\b|shell|terminal|powershell/i, "cli"],
  [/\bbrowser\b|agent-browser|playwright|devtools/i, "browser"],
  [/\binstall(?:er)?\b/i, "installer"],
  [/\bdocs?\b|readme|skill|agents\.md/i, "docs"],
];

function stripVietnameseDiacritics(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

/** Normalize a virtual branch identifier to lowercase [a-z0-9._-], max 48 chars. */
export function normalizeBranch(raw, fallback = "main") {
  const s = stripVietnameseDiacritics(String(raw ?? ""))
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 48);
  return s || fallback;
}

/** Normalize comma-separated or array tags to deduplicated lowercase slugs (max 16). */
export function normalizeTags(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const clean = stripVietnameseDiacritics(String(item ?? ""))
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 32);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 16) break;
  }
  return out;
}

/** Walk up to 4 levels from dirPath to read .git/HEAD without spawning git. */
export function readGitBranch(dirPath) {
  const rawDir = String(dirPath || "").trim();
  if (!rawDir) return "";
  let cur;
  try {
    cur = resolve(rawDir);
    if (existsSync(cur) && statSync(cur).isFile()) cur = dirname(cur);
  } catch {
    return "";
  }

  for (let depth = 0; depth < 4 && cur; depth += 1) {
    const gitEntry = join(cur, ".git");
    if (existsSync(gitEntry)) {
      try {
        let headPath = "";
        const st = statSync(gitEntry);
        if (st.isDirectory()) {
          headPath = join(gitEntry, "HEAD");
        } else if (st.isFile()) {
          const ptr = readFileSync(gitEntry, "utf8");
          const m = ptr.match(/^gitdir:\s*(.+)$/im);
          if (m) {
            const gitDir = resolve(cur, m[1].trim());
            headPath = join(gitDir, "HEAD");
          }
        }
        if (headPath && existsSync(headPath)) {
          const headText = readFileSync(headPath, "utf8").trim();
          const refMatch = headText.match(/^ref:\s*refs\/heads\/(.+)$/i);
          if (refMatch) {
            const branchName = normalizeBranch(refMatch[1], "");
            if (branchName && !DEFAULT_BRANCHES.has(branchName)) {
              return branchName;
            }
            return "";
          }
        }
      } catch {
        return "";
      }
      break;
    }
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return "";
}

function projectSlug(workspaceOrProject) {
  const raw = toPosix(String(workspaceOrProject || "").trim()).replace(/\/+$/, "");
  if (!raw) return "";
  const base = normalizeBranch(basename(raw), "");
  if (!base || NOISE_SEGMENTS.has(base)) return "";
  return base.slice(0, 20);
}

function extractPromptKeywords(text, skipWord = "") {
  const sanitized = stripVietnameseDiacritics(String(text || ""))
    .replace(/\/compact\b/gi, " ")
    .replace(/\bsave_token_(?:resume|handoff|search|stats|exec|poll)\s*\([^)]*\)/gi, " ")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ")
    .replace(/@\[[^\]]+\]/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[A-Za-z]:[\\/][^\s]+/g, " ")
    .toLowerCase();
  const tokens = sanitized.match(/[a-z0-9][a-z0-9._-]{1,24}/g) || [];
  const metaNoise = new Set(["conversationid", "handoffid", "transcriptpath", "save_token_resume", "save_token_handoff"]);
  const out = [];
  const seen = new Set();
  for (const rawTok of tokens) {
    const tok = rawTok.replace(/^[._-]+|[._-]+$/g, "");
    if (!tok || tok.length < 2 || /^\d+$/.test(tok)) continue;
    if (STOPWORDS.has(tok) || metaNoise.has(tok) || (skipWord && tok === skipWord) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 3) break;
  }
  return out;
}

function inferBranchFromFiles(touchedFiles, skipWord = "") {
  if (!Array.isArray(touchedFiles) || touchedFiles.length === 0) return "";
  const counts = new Map();
  for (const fp of touchedFiles) {
    const parts = toPosix(fp).split("/").filter(Boolean);
    for (let i = 0; i < Math.max(0, parts.length - 1); i += 1) {
      const seg = normalizeBranch(parts[i], "");
      if (!seg || NOISE_SEGMENTS.has(seg) || seg.length < 2 || (skipWord && seg === skipWord)) continue;
      counts.set(seg, (counts.get(seg) || 0) + 1);
    }
  }
  let best = "";
  let bestCount = 0;
  for (const [seg, c] of counts.entries()) {
    if (c > bestCount) {
      best = seg;
      bestCount = c;
    }
  }
  return best;
}

/** Infer a concise virtual context branch name with 0 LLM tokens. */
export function inferBranch({
  explicitBranch,
  workspace,
  project,
  title,
  firstUserPrompt,
  touchedFiles,
} = {}) {
  const rawExplicit = String(explicitBranch ?? "").trim();
  if (rawExplicit && rawExplicit.toLowerCase() !== "auto") {
    return { branch: normalizeBranch(rawExplicit), inferred: false, source: "explicit" };
  }

  const gitBranch = readGitBranch(workspace) || readGitBranch(project);
  if (gitBranch) {
    return { branch: normalizeBranch(gitBranch), inferred: true, source: "git" };
  }

  const proj = projectSlug(workspace || project);
  const promptText = `${String(title || "")} ${String(firstUserPrompt || "")}`.trim();
  const keywords = extractPromptKeywords(promptText, proj);
  if (keywords.length > 0) {
    const combined = proj && !keywords.includes(proj)
      ? `${proj}-${keywords.slice(0, 2).join("-")}`
      : keywords.join("-");
    const slug = normalizeBranch(combined, "");
    if (slug && !DEFAULT_BRANCHES.has(slug)) {
      return { branch: slug, inferred: true, source: "prompt" };
    }
  }

  const fileBranch = inferBranchFromFiles(touchedFiles, proj);
  if (fileBranch) {
    const combined = proj && proj !== fileBranch ? `${proj}-${fileBranch}` : fileBranch;
    return { branch: normalizeBranch(combined), inferred: true, source: "files" };
  }

  if (proj && !DEFAULT_BRANCHES.has(proj)) {
    return { branch: proj, inferred: true, source: "project" };
  }

  return { branch: "main", inferred: false, source: "default" };
}

/** Infer up to 5 scoped tags (max 6 total) from touched files, prompt keywords, and errors. */
export function inferTags({
  explicitTags,
  touchedFiles,
  title,
  firstUserPrompt,
  recentErrors,
  maxAutoTags = 5,
} = {}) {
  const explicitClean = normalizeTags(explicitTags);
  if (explicitClean.length >= 3) {
    return { tags: explicitClean, inferred: false };
  }

  const out = [...explicitClean];
  const seen = new Set(out);
  const cap = Math.min(6, Math.max(explicitClean.length, maxAutoTags + explicitClean.length));
  const addTag = (raw) => {
    if (out.length >= cap) return false;
    const clean = normalizeTags([raw])[0];
    if (!clean || seen.has(clean) || NOISE_SEGMENTS.has(clean)) return false;
    seen.add(clean);
    out.push(clean);
    return true;
  };

  if (Array.isArray(touchedFiles)) {
    const moduleHits = [];
    const fileStemHits = [];
    for (const fp of touchedFiles) {
      const parts = toPosix(fp).split("/").filter(Boolean);
      for (let i = 0; i < parts.length - 1; i += 1) {
        const seg = parts[i].toLowerCase();
        if (NOISE_SEGMENTS.has(seg)) continue;
        if (MODULE_TAG_HINTS.has(seg)) moduleHits.push(seg);
      }
      const base = parts[parts.length - 1] || "";
      const stem = base.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
      if (stem && !NOISE_SEGMENTS.has(stem) && stem !== "index" && stem !== "main" && stem.length >= 2) {
        const firstPart = stem.split(/[-_.]/)[0];
        if (MODULE_TAG_HINTS.has(stem)) fileStemHits.push(stem);
        else if (firstPart && MODULE_TAG_HINTS.has(firstPart)) fileStemHits.push(firstPart);
        else fileStemHits.push(stem);
      }
    }
    for (const m of moduleHits) addTag(m);
    for (const s of fileStemHits) addTag(s);
  }

  const normalizedText = stripVietnameseDiacritics(`${String(title || "")} ${String(firstUserPrompt || "")}`);
  for (const [re, tag] of KEYWORD_TAG_RULES) {
    if (out.length >= cap) break;
    if (re.test(normalizedText)) addTag(tag);
  }

  if (Array.isArray(recentErrors) && recentErrors.length > 0) {
    addTag("debug");
  }

  return { tags: out, inferred: out.length > explicitClean.length };
}
