---
name: lean-review
description: Quality review of a diff/PR/commit or full-repo audit: bugs, security/data loss, scale, missing tests, speed, and code bloat to delete/merge/split. Ranked findings with concrete cases. Use for "review this", "review PR", "audit codebase", "find bloat", /lean-review.
---

# Lean Review & Audit

Review changes or audit a repository like the senior developer who will be paged when it breaks. Priority order: **correct, safe, holds under load, tested, fast, lean**. One-shot report; change no code.

## 1. Understand Scope & Context First

- **Change / PR review** (default: uncommitted changes or last commit if none named): Read the diff, then read connected code — callers of every changed function, callees, related tests, and README. Grep all callers whenever a signature, return value, or behavior changes.
- **Repo / folder audit** (when asked to audit a repo, package, or folder): Read README, build/deploy configs, dependencies, entry points (main, routes, handlers, jobs, CLI), and tests. Trace main data flows end to end (user input, auth, money, writes, background jobs, shared state). On big repos, focus on high-cost paths and note unread areas.
- **Save tokens while scanning:** When reading 3+ files or searching across the tree, use `save_token_exec` (`tools.grep`, `tools.read`, `git`) instead of dumping whole large files.
- **State expected load:** Determine from README/deploy config whether the workload is single-user local scripts or concurrent multi-user/multi-process traffic, and judge scale against that assumption.

## 2. Inspection Checklist (Ranked Order)

1. **Bug:** Wrong output, crashes, missed edge cases (empty, zero, last item, rounding, time zones), broken callers, or inconsistent logic across duplicate paths.
2. **Risk:** Security holes (injection, weak randomness, hardcoded secrets, missing trust-boundary validation) and data loss (swallowed errors, out-of-order writes, missing transactions).
3. **Scale:** Works for 1 user, fails under concurrency/growth (check-then-write races, unbounded memory/lists, N+1 queries, $O(n^2)$ loops, unshared per-process state).
4. **Missing test:** Risky logic (branches, parsers, money, security, data writes, bug fixes) lacking a test that fails when broken.
5. **Speed:** Significant slowdowns or repeated hot-loop work where latency matters.
6. **Lean (cut bloat):**
   - *Delete:* Dead code, unused flags/options, speculative features.
   - *Reuse / Stdlib:* Duplicate helpers (keep one, name path) or dependencies replaceable by stdlib/platform features.
   - *YAGNI / Merge / Split:* Single-impl interfaces, pass-through wrappers, near-copies, or functions mixing unrelated jobs (split by responsibility, never by line count).

## 3. Verification Rules

- **No case, no finding:** Every finding must describe a concrete input or scenario causing a wrong result or failure.
- Confirm unused-code claims across the whole tree (tests, fixtures, configs, dynamic/string refs).
- Respect valid `shortcut: <limit>, <upgrade>` (or legacy `ponytail:`) comments unless expected load already crosses the stated limit.
- Propose the smallest fix (prefer deletion); ignore subjective style preferences or vague warnings.

## 4. Output Format

1. Start with `What this change/repo does:` (2–3 sentences + assumed load).
2. Group findings under **Must fix**, **Should fix**, and **Nice to have** (skip empty groups; number sequentially across all groups, max 20 items, note count if smaller items omitted). Each item includes:
   - **Title** (`file:Lstart-Lend`)
   - **What this is** / **Problem** / **Fix** (smallest change) / **If we skip it**
3. End with:
   - `Verdict:` (`Ship.` / `Healthy.` or which numbered items to fix first)
   - `Lean:` `-<N> lines, -<M> dependencies possible.` (if applicable)
   - `Not checked:` parts skipped, unread, or not run.
