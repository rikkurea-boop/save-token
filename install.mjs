#!/usr/bin/env node
/**
 * Zero-dependency universal installer for save-token across:
 * Antigravity, Claude Code, Codex, DeepSeek Harness (dsh), Cursor, Gemini CLI, and OpenCode.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ALL_TARGETS = ["antigravity", "claude", "codex", "dsh", "cursor", "gemini-cli", "opencode"];
const SHARED_SKILLS = ["save-token", "save-token-terse", "lean-review"];
const BEGIN_MARK = "# BEGIN save-token";
const END_MARK = "# END save-token";

const CORE_ITEMS = [
  "server",
  "scripts",
  "skills",
  "rules",
  "plugin.json",
];

function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

function resolveHome() {
  return process.env.SAVE_TOKEN_HOME ? path.resolve(process.env.SAVE_TOKEN_HOME) : os.homedir();
}

function parseArgs(argv) {
  const opts = {
    targets: ["auto"],
    dryRun: false,
    uninstall: false,
    skipBrowser: process.env.SAVE_TOKEN_SKIP_BROWSER === "1",
    skipHooks: process.env.SAVE_TOKEN_SKIP_HOOKS === "1",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--uninstall") opts.uninstall = true;
    else if (a === "--skip-browser") opts.skipBrowser = true;
    else if (a === "--skip-hooks") opts.skipHooks = true;
    else if (a === "--target" && argv[i + 1]) {
      opts.targets = argv[++i]
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`save-token-install — Universal installer (Node >= 22.5, zero dependencies)

Usage:
  node install.mjs [--target <list>] [--dry-run] [--skip-browser] [--skip-hooks] [--uninstall]

Targets:
  auto         Detect installed harnesses (default)
  all          Install for all supported harnesses (${ALL_TARGETS.join(", ")})
  antigravity  ~/.gemini/config/plugins/save-token
  claude       ~/.claude/skills/* + ~/.claude.json + ~/.claude/settings.json hooks
  codex        ~/.agents/skills/* + ~/.codex/config.toml
  dsh          ~/.agents/skills/* + ~/.dsh/save-token.cordis.yml
  cursor       ~/.agents/skills/* + ~/.cursor/mcp.json + ~/.cursor/hooks.json
  gemini-cli   ~/.agents/skills/* + ~/.gemini/settings.json (MCP + hooks)
  opencode     ~/.agents/skills/* + ~/.config/opencode/opencode.json

Options:
  --dry-run       Preview actions without writing files or running npm install
  --skip-browser  Skip automatic global installation of agent-browser CLI
  --skip-hooks    Skip wiring PreToolUse/BeforeTool/SessionStart hooks
  --uninstall     Remove save-token files, hooks, and config blocks cleanly`);
}

function detectTargets(home) {
  const checks = [
    ["antigravity", [path.join(home, ".gemini", "antigravity"), path.join(home, ".gemini", "config")]],
    ["claude", [path.join(home, ".claude"), path.join(home, ".claude.json")]],
    ["codex", [path.join(home, ".codex")]],
    ["dsh", [path.join(home, ".dsh")]],
    ["cursor", [path.join(home, ".cursor")]],
    ["gemini-cli", [path.join(home, ".gemini", "settings.json")]],
    ["opencode", [path.join(home, ".config", "opencode"), path.join(home, ".opencode")]],
  ];
  return checks.filter(([, paths]) => paths.some((p) => fs.existsSync(p))).map(([name]) => name);
}

function copyTree(srcDir, dstDir, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dstDir, { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true, force: true });
}

function installCoreBundle(dstDir, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const item of CORE_ITEMS) {
    const src = path.join(REPO_ROOT, item);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(dstDir, item), { recursive: true, force: true });
  }
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function writeJson(filePath, obj, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function upsertJsonMcp(filePath, entry, dryRun) {
  const cfg = readJsonSafe(filePath);
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
  cfg.mcpServers["save-token"] = entry;
  writeJson(filePath, cfg, dryRun);
}

function removeJsonMcp(filePath, dryRun) {
  if (!fs.existsSync(filePath)) return false;
  const cfg = readJsonSafe(filePath);
  if (!cfg.mcpServers || !Object.prototype.hasOwnProperty.call(cfg.mcpServers, "save-token")) {
    return false;
  }
  delete cfg.mcpServers["save-token"];
  writeJson(filePath, cfg, dryRun);
  return true;
}

function upsertTomlBlock(filePath, nodeCmd, serverPath, dryRun) {
  const block = [
    BEGIN_MARK,
    "[mcp_servers.save-token]",
    `command = ${JSON.stringify(nodeCmd)}`,
    `args = ["--no-warnings=ExperimentalWarning", ${JSON.stringify(serverPath)}]`,
    END_MARK,
  ].join("\n");

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const re = new RegExp(`${BEGIN_MARK}[\\s\\S]*?${END_MARK}\\r?\\n?`, "g");
  const cleaned = existing.replace(re, "").trimEnd();
  const next = cleaned ? `${cleaned}\n\n${block}\n` : `${block}\n`;
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, next, "utf8");
  }
}

function removeTomlBlock(filePath, dryRun) {
  if (!fs.existsSync(filePath)) return false;
  const existing = fs.readFileSync(filePath, "utf8");
  const re = new RegExp(`\\r?\\n?${BEGIN_MARK}[\\s\\S]*?${END_MARK}\\r?\\n?`, "g");
  if (!re.test(existing)) return false;
  const next = existing.replace(re, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!dryRun) {
    fs.writeFileSync(filePath, next ? next + "\n" : "", "utf8");
  }
  return true;
}

function findExecutable(name) {
  const rawPath = process.env.PATH || process.env.Path || "";
  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  if (process.platform === "darwin") {
    for (const p of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (!dirs.includes(p)) dirs.push(p);
    }
  }
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) return toPosix(candidate);
      } catch {
        // ignore missing entries
      }
    }
  }
  return null;
}

function ensureAgentBrowser(opts) {
  const existing = findExecutable("agent-browser");
  if (existing) {
    console.log(`agent-browser: already installed at ${existing}`);
    return;
  }
  if (opts.skipBrowser) {
    console.log("agent-browser: skipped (--skip-browser)");
    return;
  }
  if (opts.dryRun) {
    console.log("agent-browser: would install globally via `npm install -g agent-browser`");
    return;
  }

  const npmBin = findExecutable("npm");
  if (!npmBin) {
    console.warn("agent-browser: npm not found on PATH — install manually later with `npm install -g agent-browser`.");
    return;
  }

  console.log("agent-browser: installing globally by default (`npm install -g agent-browser`)...");
  const res = spawnSync(npmBin, ["install", "-g", "agent-browser"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status === 0) {
    const installedPath = findExecutable("agent-browser");
    console.log(`agent-browser: installed${installedPath ? ` at ${installedPath}` : ""}`);
  } else {
    console.warn("agent-browser: auto-install failed (MCP tools still work). Retry manually: `npm install -g agent-browser`.");
  }
}

function isSaveTokenHookEntry(entry) {
  return JSON.stringify(entry || "").includes("save-token");
}

function upsertJsonHooks(filePath, hookSpecs, dryRun, extraRoot = {}) {
  const cfg = readJsonSafe(filePath);
  for (const [k, v] of Object.entries(extraRoot)) {
    if (cfg[k] == null) cfg[k] = v;
  }
  if (!cfg.hooks || typeof cfg.hooks !== "object") cfg.hooks = {};
  for (const [eventName, newEntry] of Object.entries(hookSpecs)) {
    const existing = Array.isArray(cfg.hooks[eventName]) ? cfg.hooks[eventName] : [];
    const cleaned = existing.filter((entry) => !isSaveTokenHookEntry(entry));
    cleaned.push(newEntry);
    cfg.hooks[eventName] = cleaned;
  }
  writeJson(filePath, cfg, dryRun);
}

function removeJsonHooks(filePath, eventNames, dryRun) {
  if (!fs.existsSync(filePath)) return false;
  const cfg = readJsonSafe(filePath);
  if (!cfg.hooks || typeof cfg.hooks !== "object") return false;
  let changed = false;
  for (const ev of eventNames) {
    if (!Array.isArray(cfg.hooks[ev])) continue;
    const filtered = cfg.hooks[ev].filter((entry) => !isSaveTokenHookEntry(entry));
    if (filtered.length !== cfg.hooks[ev].length) {
      changed = true;
      if (filtered.length > 0) cfg.hooks[ev] = filtered;
      else delete cfg.hooks[ev];
    }
  }
  if (changed) {
    if (Object.keys(cfg.hooks).length === 0 && cfg.version == null) delete cfg.hooks;
    writeJson(filePath, cfg, dryRun);
  }
  return changed;
}

function upsertOpenCodeMcp(filePath, nodeCmd, serverPath, dryRun) {
  const cfg = readJsonSafe(filePath);
  if (!cfg.$schema) cfg.$schema = "https://opencode.ai/config.json";
  if (!cfg.mcp || typeof cfg.mcp !== "object") cfg.mcp = {};
  cfg.mcp["save-token"] = {
    type: "local",
    command: [nodeCmd, "--no-warnings=ExperimentalWarning", serverPath],
    enabled: true,
  };
  writeJson(filePath, cfg, dryRun);
}

function removeOpenCodeMcp(filePath, dryRun) {
  if (!fs.existsSync(filePath)) return false;
  const cfg = readJsonSafe(filePath);
  if (!cfg.mcp || !Object.prototype.hasOwnProperty.call(cfg.mcp, "save-token")) return false;
  delete cfg.mcp["save-token"];
  writeJson(filePath, cfg, dryRun);
  return true;
}

function copySkillsList(dstSkillsRoot, dryRun) {
  for (const sk of SHARED_SKILLS) {
    const src = path.join(REPO_ROOT, "skills", sk);
    if (fs.existsSync(src)) copyTree(src, path.join(dstSkillsRoot, sk), dryRun);
  }
}

function removeSkillsList(dstSkillsRoot, dryRun) {
  for (const sk of SHARED_SKILLS) {
    const dst = path.join(dstSkillsRoot, sk);
    if (fs.existsSync(dst) && !dryRun) fs.rmSync(dst, { recursive: true, force: true });
  }
}

function installForTargets(targets, home, opts) {
  const nodeCmd = toPosix(process.execPath);
  const coreRoot = path.join(home, ".save-token");
  const coreServer = toPosix(path.join(coreRoot, "server", "save-token-mcp.mjs"));
  const preToolScript = toPosix(path.join(coreRoot, "scripts", "pre-tool-guard-hook.mjs"));
  const sessionStartScript = toPosix(path.join(coreRoot, "scripts", "session-start-hook.mjs"));
  const hookCmd = (scriptPath) => `node --no-warnings=ExperimentalWarning ${JSON.stringify(scriptPath)}`;
  const sharedSkillsRoot = path.join(home, ".agents", "skills");
  const actions = [];

  const needsSharedCore = targets.some((t) => t !== "antigravity") || targets.length === 0;
  if (needsSharedCore) {
    if (opts.uninstall) {
      if (fs.existsSync(coreRoot) && !opts.dryRun) fs.rmSync(coreRoot, { recursive: true, force: true });
      removeSkillsList(sharedSkillsRoot, opts.dryRun);
      actions.push(`Removed shared core ${toPosix(coreRoot)} & skills ${toPosix(sharedSkillsRoot)}/*`);
    } else {
      installCoreBundle(coreRoot, opts.dryRun);
      copySkillsList(sharedSkillsRoot, opts.dryRun);
      actions.push(`Installed shared core -> ${toPosix(coreRoot)}`);
      actions.push(`Installed shared skills (${SHARED_SKILLS.join(", ")}) -> ${toPosix(sharedSkillsRoot)}`);
    }
  }

  const jsonTargets = {
    claude: {
      configPath: path.join(home, ".claude.json"),
      entry: { type: "stdio", command: nodeCmd, args: ["--no-warnings=ExperimentalWarning", coreServer] },
      skillsRoot: path.join(home, ".claude", "skills"),
      hooksPath: path.join(home, ".claude", "settings.json"),
      hookEvents: ["PreToolUse", "SessionStart"],
      hookSpecs: {
        PreToolUse: {
          matcher: "Bash|Read",
          hooks: [{ type: "command", command: hookCmd(preToolScript), timeout: 5 }],
        },
        SessionStart: {
          hooks: [{ type: "command", command: hookCmd(sessionStartScript), timeout: 5 }],
        },
      },
    },
    cursor: {
      configPath: path.join(home, ".cursor", "mcp.json"),
      entry: { command: nodeCmd, args: ["--no-warnings=ExperimentalWarning", coreServer] },
      hooksPath: path.join(home, ".cursor", "hooks.json"),
      hookEvents: ["preToolUse"],
      hookExtraRoot: { version: 1 },
      hookSpecs: {
        preToolUse: { command: hookCmd(preToolScript) },
      },
    },
    "gemini-cli": {
      configPath: path.join(home, ".gemini", "settings.json"),
      entry: { command: nodeCmd, args: ["--no-warnings=ExperimentalWarning", coreServer] },
      hooksPath: path.join(home, ".gemini", "settings.json"),
      hookEvents: ["BeforeTool", "SessionStart"],
      hookSpecs: {
        BeforeTool: {
          matcher: "run_shell_command|read_file",
          hooks: [{ name: "save-token-guard", type: "command", command: hookCmd(preToolScript), timeout: 5000 }],
        },
        SessionStart: {
          hooks: [{ name: "save-token-cache", type: "command", command: hookCmd(sessionStartScript), timeout: 5000 }],
        },
      },
    },
  };

  for (const target of targets) {
    if (target === "antigravity") {
      const agyRoot = path.join(home, ".gemini", "config", "plugins", "save-token");
      if (opts.uninstall) {
        if (fs.existsSync(agyRoot) && !opts.dryRun) fs.rmSync(agyRoot, { recursive: true, force: true });
        actions.push(`[antigravity] Removed ${toPosix(agyRoot)} (reload UI Customizations if open)`);
      } else {
        installCoreBundle(agyRoot, opts.dryRun);
        const agyHooksSrc = path.join(REPO_ROOT, "hooks.json");
        if (fs.existsSync(agyHooksSrc) && !opts.dryRun) {
          fs.copyFileSync(agyHooksSrc, path.join(agyRoot, "hooks.json"));
        }
        const agySidecarsSrc = path.join(REPO_ROOT, "sidecars");
        if (fs.existsSync(agySidecarsSrc)) copyTree(agySidecarsSrc, path.join(agyRoot, "sidecars"), opts.dryRun);
        const agyServer = toPosix(path.join(agyRoot, "server", "save-token-mcp.mjs"));
        writeJson(
          path.join(agyRoot, "mcp_config.json"),
          { mcpServers: { "save-token": { command: nodeCmd, args: ["--no-warnings=ExperimentalWarning", agyServer] } } },
          opts.dryRun
        );
        actions.push(`[antigravity] Installed plugin -> ${toPosix(agyRoot)}`);
      }
      continue;
    }

    if (jsonTargets[target]) {
      const spec = jsonTargets[target];
      if (opts.uninstall) {
        const removed = removeJsonMcp(spec.configPath, opts.dryRun);
        const hooksRemoved = spec.hooksPath ? removeJsonHooks(spec.hooksPath, spec.hookEvents, opts.dryRun) : false;
        if (spec.skillsRoot) removeSkillsList(spec.skillsRoot, opts.dryRun);
        actions.push(
          `[${target}] ${removed || hooksRemoved ? "Removed" : "Skipped"} save-token in ${toPosix(spec.configPath)}`
        );
      } else {
        upsertJsonMcp(spec.configPath, spec.entry, opts.dryRun);
        if (spec.skillsRoot) copySkillsList(spec.skillsRoot, opts.dryRun);
        if (spec.hooksPath && !opts.skipHooks) {
          upsertJsonHooks(spec.hooksPath, spec.hookSpecs, opts.dryRun, spec.hookExtraRoot || {});
        }
        const hookNote = spec.hooksPath && !opts.skipHooks ? ` + hooks(${toPosix(spec.hooksPath)})` : "";
        actions.push(
          `[${target}] Updated ${toPosix(spec.configPath)}${spec.skillsRoot ? ` + ${toPosix(spec.skillsRoot)}` : ""}${hookNote}`
        );
      }
      continue;
    }

    if (target === "opencode") {
      const ocPath = path.join(home, ".config", "opencode", "opencode.json");
      if (opts.uninstall) {
        const removed = removeOpenCodeMcp(ocPath, opts.dryRun);
        actions.push(`[opencode] ${removed ? "Removed" : "Skipped"} save-token in ${toPosix(ocPath)}`);
      } else {
        upsertOpenCodeMcp(ocPath, nodeCmd, coreServer, opts.dryRun);
        actions.push(`[opencode] Updated ${toPosix(ocPath)} (+ shared skills ~/.agents/skills/*)`);
      }
      continue;
    }

    if (target === "codex") {
      const codexToml = path.join(home, ".codex", "config.toml");
      if (opts.uninstall) {
        const removed = removeTomlBlock(codexToml, opts.dryRun);
        actions.push(`[codex] ${removed ? "Removed" : "Skipped"} block in ${toPosix(codexToml)}`);
      } else {
        upsertTomlBlock(codexToml, nodeCmd, coreServer, opts.dryRun);
        actions.push(`[codex] Updated ${toPosix(codexToml)} (+ shared skill ~/.agents/skills/save-token)`);
      }
      continue;
    }

    if (target === "dsh") {
      const dshDir = path.join(home, ".dsh");
      const cordisSnippet = path.join(dshDir, "save-token.cordis.yml");
      const rulesCopy = path.join(dshDir, "save-token.AGENTS.md");
      if (opts.uninstall) {
        if (!opts.dryRun) {
          fs.rmSync(cordisSnippet, { force: true });
          fs.rmSync(rulesCopy, { force: true });
        }
        actions.push(`[dsh] Removed ${toPosix(cordisSnippet)} & ${toPosix(rulesCopy)}`);
      } else {
        const yml = [
          "# Include this plugin entry inside `plugins:` of your DeepSeek Harness cordis.yml",
          "# Skill ~/.agents/skills/save-token is auto-loaded by @deepseek-ai/dsh-skill-filesystem",
          "- id: mcp-save-token",
          "  name: '@deepseek-ai/dsh-mcp-client'",
          "  enabled: true",
          "  config:",
          "    transport: stdio",
          `    command: ${JSON.stringify(nodeCmd)}`,
          "    args:",
          '      - "--no-warnings=ExperimentalWarning"',
          `      - ${JSON.stringify(coreServer)}`,
          "",
        ].join("\n");
        if (!opts.dryRun) {
          fs.mkdirSync(dshDir, { recursive: true });
          fs.writeFileSync(cordisSnippet, yml, "utf8");
          fs.copyFileSync(path.join(REPO_ROOT, "rules", "AGENTS.md"), rulesCopy);
        }
        actions.push(`[dsh] Wrote ${toPosix(cordisSnippet)} + ${toPosix(rulesCopy)}`);
      }
    }
  }

  return actions;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(`Error: Node.js >= 22.5.0 is required (found ${process.versions.node}) for built-in node:sqlite.`);
    process.exit(1);
  }

  const home = resolveHome();
  let targets = [];
  if (opts.targets.includes("all")) {
    targets = [...ALL_TARGETS];
  } else if (opts.targets.includes("auto")) {
    targets = detectTargets(home);
  } else {
    for (const t of opts.targets) {
      if (!ALL_TARGETS.includes(t)) {
        console.error(`Unknown target "${t}". Supported: ${ALL_TARGETS.join(", ")}, auto, all`);
        process.exit(1);
      }
      if (!targets.includes(t)) targets.push(t);
    }
  }

  const actions = installForTargets(targets, home, opts);
  const modeTag = opts.dryRun ? " (DRY RUN)" : "";
  console.log(`save-token ${opts.uninstall ? "uninstall" : "install"}${modeTag} — home: ${toPosix(home)}`);
  if (targets.length === 0) {
    console.log("No existing harness config dir detected; installed shared core + ~/.agents/skills/save-token.");
  } else {
    console.log(`Targets: ${targets.join(", ")}`);
  }
  for (const a of actions) console.log(`  - ${a}`);

  if (!opts.uninstall) {
    ensureAgentBrowser(opts);
  }
}

main();
