import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALLER = path.resolve(__dirname, "../install.mjs");

async function runInstaller(args, fakeHome, { clearPath = false, skipBrowser = true } = {}) {
  const env = { ...process.env, SAVE_TOKEN_HOME: fakeHome, SAVE_TOKEN_SKIP_BROWSER: skipBrowser ? "1" : "0" };
  if (clearPath) {
    for (const k of Object.keys(env)) {
      if (/^path$/i.test(k)) delete env[k];
    }
    env.PATH = "";
  }
  return execFileAsync(process.execPath, [INSTALLER, ...args], { env });
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "save-token-inst-"));
  const fakeEmptyHome = await fs.mkdtemp(path.join(os.tmpdir(), "save-token-auto-"));

  try {
    // Seed existing user configurations to ensure zero clobbering
    await fs.mkdir(path.join(fakeHome, ".gemini", "antigravity"), { recursive: true });
    await fs.mkdir(path.join(fakeHome, ".codex"), { recursive: true });
    await fs.mkdir(path.join(fakeHome, ".cursor"), { recursive: true });
    await fs.mkdir(path.join(fakeHome, ".dsh"), { recursive: true });

    await fs.writeFile(
      path.join(fakeHome, ".claude.json"),
      JSON.stringify({ theme: "dark", mcpServers: { existingServer: { command: "echo" } } }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(fakeHome, ".codex", "config.toml"),
      'model = "gpt-5"\n\n[mcp_servers.user_tool]\ncommand = "echo"\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(fakeHome, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { keepMe: { command: "python" } } }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(fakeHome, ".gemini", "settings.json"),
      JSON.stringify({ general: { vimMode: true }, mcpServers: { existingGemini: { command: "node" } } }, null, 2),
      "utf8"
    );

    // 1. Dry-run should not create core files
    const dryRes = await runInstaller(["--target", "all", "--dry-run"], fakeHome);
    assert.match(dryRes.stdout, /DRY RUN/);
    assert.equal(await exists(path.join(fakeHome, ".save-token")), false);

    // 2. Full install across all 6 targets
    const allRes = await runInstaller(["--target", "all"], fakeHome);
    assert.match(allRes.stdout, /antigravity, claude, codex, dsh, cursor, gemini-cli/);

    // Verify Antigravity
    const agyMcp = JSON.parse(
      await fs.readFile(path.join(fakeHome, ".gemini", "config", "plugins", "save-token", "mcp_config.json"), "utf8")
    );
    assert.ok(agyMcp.mcpServers["save-token"].args[1].endsWith("/save-token-mcp.mjs"));

    // Verify Claude Code preserves existing keys
    const claudeCfg = JSON.parse(await fs.readFile(path.join(fakeHome, ".claude.json"), "utf8"));
    assert.equal(claudeCfg.theme, "dark");
    assert.ok(claudeCfg.mcpServers.existingServer);
    assert.equal(claudeCfg.mcpServers["save-token"].type, "stdio");
    assert.equal(await exists(path.join(fakeHome, ".claude", "skills", "save-token", "SKILL.md")), true);

    // Verify Codex preserves existing config & injects block once
    const codexToml = await fs.readFile(path.join(fakeHome, ".codex", "config.toml"), "utf8");
    assert.match(codexToml, /\[mcp_servers\.user_tool\]/);
    assert.match(codexToml, /\[mcp_servers\.save-token\]/);
    assert.equal(await exists(path.join(fakeHome, ".agents", "skills", "save-token", "SKILL.md")), true);

    // Verify DeepSeek Harness (dsh) adapter & rule copy
    const dshYml = await fs.readFile(path.join(fakeHome, ".dsh", "save-token.cordis.yml"), "utf8");
    assert.match(dshYml, /@deepseek-ai\/dsh-mcp-client/);
    assert.match(dshYml, /\.save-token\/server\/save-token-mcp\.mjs/);
    assert.equal(await exists(path.join(fakeHome, ".dsh", "save-token.AGENTS.md")), true);

    // Verify Cursor & Gemini CLI preserve existing entries
    const cursorCfg = JSON.parse(await fs.readFile(path.join(fakeHome, ".cursor", "mcp.json"), "utf8"));
    assert.ok(cursorCfg.mcpServers.keepMe);
    assert.ok(cursorCfg.mcpServers["save-token"]);

    const geminiCfg = JSON.parse(await fs.readFile(path.join(fakeHome, ".gemini", "settings.json"), "utf8"));
    assert.equal(geminiCfg.general.vimMode, true);
    assert.ok(geminiCfg.mcpServers.existingGemini);
    assert.ok(geminiCfg.mcpServers["save-token"]);

    // 3. Idempotency: running twice must not duplicate Codex TOML block
    await runInstaller(["--target", "all"], fakeHome);
    const codexToml2 = await fs.readFile(path.join(fakeHome, ".codex", "config.toml"), "utf8");
    assert.equal(codexToml2.match(/# BEGIN save-token/g)?.length, 1);

    // 4. Uninstall cleanly removes save-token while preserving user settings
    await runInstaller(["--uninstall", "--target", "all"], fakeHome);
    assert.equal(await exists(path.join(fakeHome, ".save-token")), false);
    assert.equal(await exists(path.join(fakeHome, ".claude", "skills", "save-token")), false);
    assert.equal(await exists(path.join(fakeHome, ".agents", "skills", "save-token")), false);
    assert.equal(await exists(path.join(fakeHome, ".dsh", "save-token.cordis.yml")), false);
    assert.equal(await exists(path.join(fakeHome, ".gemini", "config", "plugins", "save-token")), false);

    const claudeAfter = JSON.parse(await fs.readFile(path.join(fakeHome, ".claude.json"), "utf8"));
    assert.ok(claudeAfter.mcpServers.existingServer);
    assert.equal(claudeAfter.mcpServers["save-token"], undefined);

    const codexAfter = await fs.readFile(path.join(fakeHome, ".codex", "config.toml"), "utf8");
    assert.match(codexAfter, /\[mcp_servers\.user_tool\]/);
    assert.doesNotMatch(codexAfter, /save-token/);

    // 5. Auto fallback on empty home installs shared core + ~/.agents/skills/save-token
    await runInstaller(["--target", "auto"], fakeEmptyHome);
    assert.equal(await exists(path.join(fakeEmptyHome, ".save-token", "server", "save-token-mcp.mjs")), true);
    assert.equal(await exists(path.join(fakeEmptyHome, ".agents", "skills", "save-token", "SKILL.md")), true);

    // 6. Default agent-browser auto-install behavior (unless --skip-browser or already on PATH)
    if (process.platform !== "darwin") {
      const defBrowser = await runInstaller(["--target", "all", "--dry-run"], fakeEmptyHome, {
        clearPath: true,
        skipBrowser: false,
      });
      assert.match(defBrowser.stdout, /would install globally via/);
    }
    const skipFlag = await runInstaller(["--target", "all", "--dry-run", "--skip-browser"], fakeEmptyHome, {
      clearPath: true,
      skipBrowser: false,
    });
    assert.match(skipFlag.stdout, /skipped \(--skip-browser\)|already installed/);

    console.log("ALL INSTALLER TESTS PASSED (6 PLATFORMS + IDEMPOTENCY + UNINSTALL + AUTO + DEFAULT BROWSER)");
  } finally {
    await fs.rm(fakeHome, { recursive: true, force: true });
    await fs.rm(fakeEmptyHome, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
