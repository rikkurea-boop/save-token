import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_PATH = path.resolve(__dirname, "save-token-mcp.mjs");
const HANDOFF_SCRIPT = path.resolve(__dirname, "../scripts/handoff-new-chat.mjs");

class McpClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrBuf = "";
    proc.stderr.on("data", (d) => {
      this.stderrBuf += d.toString();
    });
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params = {}) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async callTool(name, args = {}) {
    const resp = await this.request("tools/call", { name, arguments: args });
    assert.ok(resp.result, `Expected JSON-RPC result for ${name}`);
    return resp.result;
  }
}

function startServer(dbPath, extraEnv = {}) {
  const proc = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_OPTIONS: "--title=should-be-stripped",
      SAVE_TOKEN_DB_PATH: dbPath,
      ...extraEnv,
    },
  });
  return { proc, client: new McpClient(proc) };
}

async function stopServer(proc) {
  await new Promise((resolve) => {
    proc.once("close", resolve);
    proc.stdin.end();
    setTimeout(() => {
      try { proc.kill(); } catch {}
      resolve();
    }, 1500);
  });
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "save-token-e2e-"));
  const dbPath = path.join(tempRoot, "data", "store.db");
  let server1 = startServer(dbPath);
  let server2 = null;
  let webServer = null;

  try {
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "node_modules", "ignored-pkg"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "alpha.js"), "export const OLD_TOKEN = 1;\n// OLD_TOKEN\n", "utf8");
    await fs.writeFile(path.join(tempRoot, "src", "beta.js"), "export const name = 'OLD_TOKEN';\n", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "node_modules", "ignored-pkg", "index.js"),
      "const OLD_TOKEN = 'must_be_ignored';\n",
      "utf8"
    );

    // Test 1: Handshake + 6 tools listed
    const init1 = await server1.client.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "save-token-test", version: "1.0.0" },
    });
    assert.equal(init1.result.serverInfo.name, "save-token");
    server1.client.notify("notifications/initialized", {});
    const listResp = await server1.client.request("tools/list");
    const toolNames = listResp.result.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      "save_token_exec",
      "save_token_handoff",
      "save_token_poll",
      "save_token_resume",
      "save_token_search",
      "save_token_stats",
    ]);
    console.log("PASS Test 1: Handshake & 6 tools listed");

    // Test 2: Persistent state across turns (600 orders -> 37 exact)
    const t2a = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      code: `
        const orders = [];
        for (let i = 1; i <= 600; i++) {
          const id = "DH" + String(i).padStart(4, "0");
          const late = (i <= 35) || i === 90 || i === 280;
          orders.push({ id, customer: (i === 90 || i === 280) ? "Đỗ Ngọc Vi" : "Khách " + i, note: late ? "Giao hàng trễ hẹn" : "OK" });
        }
        state.orders = orders;
        return { total: state.orders.length, sample: state.orders.slice(0, 2) };
      `,
    });
    assert.equal(t2a.isError, false, t2a.content[0].text);
    const t2b = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      code: `
        const hits = state.orders.filter(o => o.note.includes("trễ"));
        return { count: hits.length, special: hits.filter(h => h.id === "DH0090" || h.id === "DH0280").map(h => h.id) };
      `,
    });
    assert.match(t2b.content[0].text, /"count": 37/);
    assert.match(t2b.content[0].text, /DH0090/);
    assert.match(t2b.content[0].text, /DH0280/);
    console.log("PASS Test 2: Persistent state across turns");

    // Test 3: Tagged template `$` (.lines, .text, .json, .nothrow)
    const t3 = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      code: `
        const lines = await $\`node -e "console.log('a\\\\nb')"\`.lines();
        const text = (await $\`node -e "console.log('hello')"\`.text()).trim();
        const parsed = await $\`node -e "console.log(JSON.stringify({ok:true}))"\`.json();
        const bad = await $\`node -e "process.exit(2)"\`.nothrow();
        return { lines, text, parsed, badCode: bad.code };
      `,
    });
    assert.equal(t3.isError, false, t3.content[0].text);
    assert.match(t3.content[0].text, /"text": "hello"/);
    assert.match(t3.content[0].text, /"badCode": 2/);
    console.log("PASS Test 3: Tagged template $ (.lines, .text, .json, .nothrow)");

    // Test 4: glob + grep + readMany + NODE_OPTIONS stripped
    const t4 = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      code: `
        const files = await tools.glob("**/*.js");
        const hits = await tools.grep("OLD_TOKEN", { glob: "**/*.js" });
        const contents = await tools.readMany(files);
        const envCheck = await $\`node -e "console.log(process.env.NODE_OPTIONS || 'STRIPPED')"\`.text();
        return { files, totalMatches: hits.totalMatches, readCount: contents.length, envCheck: envCheck.trim() };
      `,
    });
    assert.equal(t4.isError, false, t4.content[0].text);
    assert.match(t4.content[0].text, /"totalMatches": 3/);
    assert.doesNotMatch(t4.content[0].text, /ignored-pkg/);
    assert.match(t4.content[0].text, /"envCheck": "STRIPPED"/);
    console.log("PASS Test 4: glob + grep + readMany & NODE_OPTIONS stripped");

    // Test 5: readonly lock blocks write & edit
    const blockedTarget = path.join(tempRoot, "src", "blocked.txt");
    const t5 = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      code: `await tools.write("src/blocked.txt", "nope");`,
    });
    assert.equal(t5.isError, true);
    assert.match(t5.content[0].text, /Permission denied/);
    await assert.rejects(fs.stat(blockedTarget));
    console.log("PASS Test 5: readonly lock rejects writes");

    // Test 6: tools.edit & batchReplace dryRun / write
    const t6Dry = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      code: `return await tools.batchReplace(await tools.glob("src/*.js"), "OLD_TOKEN", "NEW_TOKEN", { dryRun: true });`,
    });
    assert.match(t6Dry.content[0].text, /"totalReplacements": 3/);
    const t6Write = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      mode: "write",
      code: `
        const e = await tools.edit("src/alpha.js", "OLD_TOKEN", "ONE_TOKEN");
        const b = await tools.batchReplace(["src/alpha.js", "src/beta.js"], "OLD_TOKEN", "NEW_TOKEN");
        return { e, b };
      `,
    });
    assert.equal(t6Write.isError, false, t6Write.content[0].text);
    const alphaTxt = await fs.readFile(path.join(tempRoot, "src", "alpha.js"), "utf8");
    assert.match(alphaTxt, /ONE_TOKEN/);
    assert.match(alphaTxt, /NEW_TOKEN/);
    console.log("PASS Test 6: tools.edit & batchReplace dryRun/write");

    // Test 7: Auto-index FTS5 BM25 intent + Trigram save_token_search
    const t7 = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      maxOutputChars: 1200,
      intent: "delivery delay",
      code: `
        const secs = Array.from({ length: 60 }, (_, i) => "## S" + i + "\\nRoutine line " + i + " ok.");
        secs[25] = "## Urgent\\nReported delivery delay for order DH0090 inside createConnection handler.";
        return secs.join("\\n\\n");
      `,
    });
    assert.match(t7.content[0].text, /INDEXED as "exec:/);
    assert.match(t7.content[0].text, /delivery delay/);
    const t7Search = await server1.client.callTool("save_token_search", {
      queries: ["DH0090", "createConnection"],
    });
    assert.match(t7Search.content[0].text, /DH0090/);
    assert.match(t7Search.content[0].text, /createConnection/);
    console.log("PASS Test 7: Auto-index FTS5 BM25 intent & Trigram search");

    // Test 8: Structural JSON truncation preserves valid JSON
    const t8 = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      maxOutputChars: 1200,
      code: `return Array.from({ length: 200 }, (_, i) => ({ idx: i, pad: "item-" + i + "-padding" }));`,
    });
    const t8Lines = t8.content[0].text.split("\n");
    const t8Footer = t8Lines.pop();
    assert.match(t8Footer, /INDEXED as "exec:/);
    const parsedT8 = JSON.parse(t8Lines.join("\n"));
    assert.ok(Array.isArray(parsedT8) && parsedT8.some((x) => typeof x === "string" && x.includes("TRUNCATED")));
    console.log("PASS Test 8: Structural JSON truncation preserves valid JSON");

    // Test 9: spawnBg + save_token_poll
    const t9Start = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      code: `return tools.spawnBg("node -e \\"setTimeout(() => console.log('bg-ok-v3'), 200)\\"");`,
    });
    const jobId = t9Start.content[0].text.match(/"jobId":\s*"([^"]+)"/)[1];
    const t9Poll = await server1.client.callTool("save_token_poll", { jobId, waitMs: 5000 });
    assert.match(t9Poll.content[0].text, /status=done/);
    assert.match(t9Poll.content[0].text, /bg-ok-v3/);
    console.log("PASS Test 9: spawnBg + save_token_poll");

    // Test 10: save_token_stats
    const t10 = await server1.client.callTool("save_token_stats", {});
    const stats = JSON.parse(t10.content[0].text);
    assert.ok(stats.bytes.rawProcessed > stats.bytes.returnedToContext);
    assert.ok(stats.bytes.savedPct > 0);
    assert.ok(stats.stateKeys.some((k) => k.key === "orders"));
    console.log("PASS Test 10: save_token_stats");

    // Test 11: Parallel Promise.all
    const t11 = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      code: `
        const [a, b] = await Promise.all([
          tools.shell("node -e \\"console.log('p1')\\""),
          tools.shell("node -e \\"console.log('p2')\\"")
        ]);
        return { a: a.stdout.trim(), b: b.stdout.trim() };
      `,
    });
    assert.match(t11.content[0].text, /"a": "p1"/);
    assert.match(t11.content[0].text, /"b": "p2"/);
    console.log("PASS Test 11: Parallel Promise.all");

    // Test 12: VM timeout catches infinite loop & keeps state
    const t12 = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      timeoutMs: 1000,
      code: `while (true) {}`,
    });
    assert.equal(t12.isError, true);
    assert.match(t12.content[0].text, /timed out/i);
    const pingResp = await server1.client.request("ping");
    assert.deepEqual(pingResp.result, {});
    console.log("PASS Test 12: VM timeout & server survival");

    // Test 13: RTK compactOutput, detectClis & fetchText HTML cleaner
    webServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><style>.x{color:red}</style><script>console.log("noise")</script></head><body><nav>Menu Junk</nav><main><h1>Real Title</h1><p>Clean body content here.</p></main><footer>Copyright Junk</footer></body></html>`);
    });
    await new Promise((resolve) => webServer.listen(0, "127.0.0.1", resolve));
    const port = webServer.address().port;

    const t13 = await server1.client.callTool("save_token_exec", {
      cwd: tempRoot,
      code: `
        const noisy = "\\x1B[32mPASS test1\\x1B[0m\\nPASS test2\\nPASS test3\\nFAIL critical bug\\nlineA\\nlineA\\nlineA\\nlineA";
        const compacted = tools.compactOutput(noisy, "test");
        const clis = tools.detectClis();
        const page = await tools.fetchText("http://127.0.0.1:${port}/");
        return { compacted, hasNode: clis.available.some(c => c.name === "node"), pageText: page.text };
      `,
    });
    assert.equal(t13.isError, false, t13.content[0].text);
    const t13Text = t13.content[0].text;
    assert.match(t13Text, /FAIL critical bug/);
    assert.match(t13Text, /collapsed \d+ passing/);
    assert.match(t13Text, /"hasNode": true/);
    assert.match(t13Text, /Real Title/);
    assert.match(t13Text, /Clean body content here/);
    assert.doesNotMatch(t13Text, /Menu Junk|Copyright Junk|console\.log/);
    console.log("PASS Test 13: RTK compactOutput, detectClis & fetchText HTML cleaner");

    // Test 14: Zero-LLM Handoff + Cross-Session SQLite Resume + handoff-new-chat.mjs --dry-run
    const mockTranscript = path.join(tempRoot, "transcript_full.jsonl");
    await fs.writeFile(
      mockTranscript,
      [
        JSON.stringify({ type: "USER_INPUT", content: "<voice_instructions>x</voice_instructions><USER_REQUEST>Build save-token plugin</USER_REQUEST><ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>" }),
        JSON.stringify({ type: "USER_INPUT", content: "<voice_instructions>x</voice_instructions><talker_agent_context>\n[2026-11-24T18:32:20-08:00] user: \"Kiểm tra hiệu quả save token\"\n[2026-11-24T18:32:27-08:00] talker: \"Talker noise should be ignored\"\n</talker_agent_context>" }),
        JSON.stringify({ type: "USER_INPUT", content: "<talker_agent_context>\n[2026-11-24T18:32:20-08:00] user: \"Kiểm tra hiệu quả save token\"\n[2026-11-24T18:32:27-08:00] talker: \"More talker noise\"\n[2026-11-24T18:35:00-08:00] user: \"Vá lỗi trích xuất voice mode\"\n</talker_agent_context>" }),
        JSON.stringify({ type: "GENERIC", content: "Created file C:\\Users\\Admin\\demo.mjs." }),
        JSON.stringify({ type: "ERROR_MESSAGE", content: "Error: minor test warning" }),
      ].join("\n") + "\n",
      "utf8"
    );

    const t14Handoff = await server1.client.callTool("save_token_handoff", {
      title: "Stage 1 Done",
      project: "save-token-proj",
      transcriptPath: mockTranscript,
      goal: "Switch to fresh chat cleanly",
      decisions: ["Use disk SQLite WAL"],
      nextSteps: ["Verify in new chat"],
      saveStateKeys: ["orders"],
      maxChars: 2400,
    });
    assert.equal(t14Handoff.isError, false, t14Handoff.content[0].text);
    const handoffObj = JSON.parse(t14Handoff.content[0].text);
    assert.ok(handoffObj.bytes <= 2400);
    assert.deepEqual(handoffObj.savedMemoryKeys, ["orders"]);
    assert.match(handoffObj.summaryMd, /Build save-token plugin/);
    assert.match(handoffObj.summaryMd, /Kiểm tra hiệu quả save token/);
    assert.match(handoffObj.summaryMd, /Vá lỗi trích xuất voice mode/);
    assert.doesNotMatch(handoffObj.summaryMd, /Talker noise should be ignored|More talker noise/);
    assert.equal(handoffObj.summaryMd.match(/Kiểm tra hiệu quả save token/g)?.length, 1);
    assert.doesNotMatch(handoffObj.summaryMd, /voice_instructions/);

    // Restart completely fresh MCP server on same store.db
    await stopServer(server1.proc);
    assert.equal(server1.client.stderrBuf, "", `Server 1 stderr: ${server1.client.stderrBuf}`);

    server2 = startServer(dbPath);
    await server2.client.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "save-token-test-2", version: "1.0.0" },
    });
    server2.client.notify("notifications/initialized", {});

    const rLayer1 = await server2.client.callTool("save_token_resume", {});
    const l1 = JSON.parse(rLayer1.content[0].text);
    assert.equal(l1.layer, 1);
    assert.equal(l1.count, 1);

    const rLayer2 = await server2.client.callTool("save_token_resume", { handoffId: "latest" });
    const l2 = JSON.parse(rLayer2.content[0].text);
    assert.equal(l2.layer, 2);
    assert.equal(l2.handoff.title, "Stage 1 Done");
    assert.ok(l2.memoryKeys.some((m) => m.key === "orders"));

    const loadOrders = await server2.client.callTool("save_token_exec", {
      code: `const o = tools.loadMemory("orders"); return { persistedCount: o.length };`,
    });
    assert.match(loadOrders.content[0].text, /"persistedCount": 600/);

    const crossSearch = await server2.client.callTool("save_token_search", { queries: ["DH0090"] });
    assert.match(crossSearch.content[0].text, /DH0090/);

    const { stdout: dryOut } = await execFileAsync(process.execPath, [
      HANDOFF_SCRIPT,
      "--handoff",
      handoffObj.filePath,
      "--title",
      "Test Handoff Chat",
      "--dry-run",
    ]);
    const dryJson = JSON.parse(dryOut);
    assert.equal(dryJson.dryRun, true);
    assert.match(dryJson.endpoint, /ConversationService\/CreateConversation$/);
    assert.match(dryJson.payload.prompt[0].text, /Stage 1 Done/);
    console.log("PASS Test 14: Cross-session SQLite resume, 0-LLM handoff & handoff-new-chat --dry-run");

    // Test 15: Auto-handoff + cache reuse via save_token_resume({ conversationId })
    const mockBrain = path.join(tempRoot, "mock-brain");
    const convUuid = "a1b2c3d4-1111-2222-3333-444455556666";
    const convLogs = path.join(mockBrain, convUuid, ".system_generated", "logs");
    await fs.mkdir(convLogs, { recursive: true });
    await fs.writeFile(path.join(mockBrain, convUuid, "plan.md"), "# Plan\n", "utf8");
    await fs.writeFile(
      path.join(convLogs, "transcript_full.jsonl"),
      [
        JSON.stringify({ type: "USER_INPUT", content: "<voice_instructions>secret</voice_instructions><USER_REQUEST>Sửa lỗi đồng bộ Fairy PC và Mac</USER_REQUEST><ADDITIONAL_METADATA>meta</ADDITIONAL_METADATA>" }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          thinking: "PRIVATE_THOUGHT_MUST_NOT_LEAK",
          content: "",
          tool_calls: [{ name: "edit_file", args: { Path: "C:\\workspace\\fairy\\peer-sync.cjs" } }],
        }),
        JSON.stringify({
          type: "CHECKPOINT",
          content: "# Resuming from a compaction\n# User Requests\n1. <voice_instructions>noise\n## 1. Task Overview\nSync PC/Mac Fairy engine.\n## 8. Next Steps\nRestart desktop app.",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          thinking: "MORE_INTERNAL_THINKING",
          content: "Đã vá xong lỗi đồng bộ peer-sync.cjs và kiểm thử đạt chuẩn.",
        }),
        JSON.stringify({ type: "ERROR_MESSAGE", content: "Sample non-fatal warning" }),
      ].join("\n") + "\n",
      "utf8"
    );

    const server3 = startServer(dbPath, { ANTIGRAVITY_BRAIN_DIR: mockBrain });
    try {
      await server3.client.request("initialize", {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "save-token-test-3", version: "1.0.0" },
      });
      server3.client.notify("notifications/initialized", {});

      const auto1 = await server3.client.callTool("save_token_resume", { conversationId: "a1b2c3d4" });
      assert.equal(auto1.isError, false, auto1.content[0].text);
      const a1 = JSON.parse(auto1.content[0].text);
      assert.equal(a1.layer, 2);
      assert.equal(a1.autoGenerated, true);
      assert.equal(a1.reusedCache, false);
      assert.equal(a1.handoff.conversationId, convUuid);
      const mdOnDisk = await fs.readFile(a1.handoff.filePath, "utf8");
      assert.match(mdOnDisk, /Sửa lỗi đồng bộ Fairy PC và Mac/);
      assert.match(a1.handoff.summaryMd, /Đã vá xong lỗi đồng bộ peer-sync\.cjs/);
      assert.match(a1.handoff.summaryMd, /peer-sync\.cjs/);
      assert.match(a1.handoff.summaryMd, /plan\.md/);
      assert.match(a1.handoff.summaryMd, /Sync PC\/Mac Fairy engine/);
      assert.doesNotMatch(a1.handoff.summaryMd, /PRIVATE_THOUGHT_MUST_NOT_LEAK|voice_instructions|source-sig/);

      // Second call must reuse cached .md without creating duplicate DB row
      const auto2 = await server3.client.callTool("save_token_resume", { conversationId: "a1b2c3d4" });
      assert.equal(auto2.isError, false);
      const a2 = JSON.parse(auto2.content[0].text);
      assert.equal(a2.reusedCache, true);
      assert.equal(a2.autoGenerated, false);
      assert.equal(a2.handoff.id, a1.handoff.id);

      // 'latest' resolution
      const autoLatest = await server3.client.callTool("save_token_resume", { conversationId: "latest" });
      const aLatest = JSON.parse(autoLatest.content[0].text);
      assert.equal(aLatest.handoff.id, a1.handoff.id);
      assert.equal(server3.client.stderrBuf, "", `Server 3 stderr: ${server3.client.stderrBuf}`);
    } finally {
      await stopServer(server3.proc);
    }
    console.log("PASS Test 15: Auto-handoff & cache reuse via save_token_resume({ conversationId })");

    // Test 16: Lifetime metrics_events persistence across restart + Output Guard warning
    const server4 = startServer(dbPath, {
      ANTIGRAVITY_BRAIN_DIR: mockBrain,
      SAVE_TOKEN_DISTILL_DIR: path.join(tempRoot, "distilled"),
    });
    try {
      await server4.client.request("initialize", {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "save-token-test-4", version: "1.0.0" },
      });
      server4.client.notify("notifications/initialized", {});
      const t16Stats = await server4.client.callTool("save_token_stats", {});
      assert.equal(t16Stats.isError, false);
      const life = JSON.parse(t16Stats.content[0].text).lifetime;
      assert.ok(life && life.events > 0, "Expected persisted lifetime events across restart");
      assert.ok(life.rawProcessed > 0);
      assert.ok(life.savedBytes > 0);
      assert.ok(life.estTokensSaved > 0);
      assert.ok(Array.isArray(life.byTool) && life.byTool.some((t) => t.tool === "exec"));

      const t16Warn = await server4.client.callTool("save_token_exec", {
        cwd: tempRoot,
        maxOutputChars: 12000,
        code: `return "X".repeat(10200);`,
      });
      assert.equal(t16Warn.isError, false);
      assert.ok(
        t16Warn.content[0].text.includes("WARN: output >=9KB"),
        `Expected >=9KB spill guard warning in footer, got: ${t16Warn.content[0].text.slice(-160)}`
      );
      assert.equal(server4.client.stderrBuf, "", `Server 4 stderr: ${server4.client.stderrBuf}`);
    } finally {
      await stopServer(server4.proc);
    }
    console.log("PASS Test 16: Lifetime metrics_events persistence & output spill guard");

    // Test 17: Shared branch/tag scoped retrieval, progress/<branch>.md & SessionStart hook
    const server5 = startServer(dbPath, {
      ANTIGRAVITY_BRAIN_DIR: mockBrain,
      SAVE_TOKEN_DISTILL_DIR: path.join(tempRoot, "distilled"),
    });
    try {
      await server5.client.request("initialize", {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "save-token-test-5", version: "1.0.0" },
      });
      server5.client.notify("notifications/initialized", {});

      // Seed 2 isolated branches with overlapping keyword 'sharedtoken'
      await server5.client.callTool("save_token_exec", {
        cwd: tempRoot,
        mode: "write",
        code: `
          tools.index("auth-notes", "sharedtoken jwt refresh handler", { branch: "auth-flow", tags: ["jwt", "api"] });
          tools.index("ui-notes", "sharedtoken css flexbox layout", { branch: "hud-ui", tags: ["css", "sse"] });
          tools.saveMemory("auth:secret", { ok: true }, { branch: "auth-flow", tags: ["jwt"] });
          tools.saveMemory("ui:layout", { compact: true }, { branch: "hud-ui", tags: ["css"] });
          return "seeded";
        `,
      });

      const hdAuth = await server5.client.callTool("save_token_handoff", {
        title: "Auth Flow Branch",
        project: tempRoot,
        branch: "auth-flow",
        tags: ["jwt", "api"],
        goal: "Isolate JWT refresh cache",
      });
      assert.equal(hdAuth.isError, false);
      const hdAuthJson = JSON.parse(hdAuth.content[0].text);
      assert.equal(hdAuthJson.branch, "auth-flow");
      assert.ok(hdAuthJson.progressPath && hdAuthJson.progressPath.endsWith("progress/auth-flow.md"));

      const hdUi = await server5.client.callTool("save_token_handoff", {
        title: "HUD UI Branch",
        project: tempRoot,
        branch: "hud-ui",
        tags: ["css", "sse"],
        goal: "Vertical compact layout",
      });
      assert.equal(hdUi.isError, false);
      const hdUiJson = JSON.parse(hdUi.content[0].text);
      assert.equal(hdUiJson.branch, "hud-ui");
      const progressContent = await fs.readFile(hdUiJson.progressPath, "utf8");
      assert.match(progressContent, /Progress Branch: hud-ui/);

      // Scoped search must NOT cross into other branches or tags
      const scopedSearch = await server5.client.callTool("save_token_search", {
        queries: ["sharedtoken"],
        branch: "auth-flow",
        tags: ["jwt"],
      });
      assert.equal(scopedSearch.isError, false);
      assert.match(scopedSearch.content[0].text, /auth-notes/);
      assert.doesNotMatch(scopedSearch.content[0].text, /ui-notes/);

      const emptyScope = await server5.client.callTool("save_token_search", {
        queries: ["sharedtoken"],
        branch: "auth-flow",
        tags: ["css"],
      });
      assert.match(emptyScope.content[0].text, /no matches in scope/);

      // Layer 1 lists branches; branch resume returns ONLY scoped memory & sources
      const resL1 = await server5.client.callTool("save_token_resume", {});
      const l1Json = JSON.parse(resL1.content[0].text);
      assert.ok(Array.isArray(l1Json.branches) && l1Json.branches.some((b) => b.branch === "hud-ui"));

      const resBranch = await server5.client.callTool("save_token_resume", { branch: "hud-ui", tags: ["css"] });
      assert.equal(resBranch.isError, false);
      const rbJson = JSON.parse(resBranch.content[0].text);
      assert.equal(rbJson.handoff.branch, "hud-ui");
      assert.ok(rbJson.memoryKeys.every((m) => m.branch === "hud-ui"));
      assert.ok(rbJson.recentIndexedSources.every((s) => s.branch === "hud-ui"));
      assert.ok(rbJson.handoff.progressMd.includes("Progress Branch: hud-ui"));

      // Verify SessionStart hook output on populated DB vs missing DB
      const hookPath = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../scripts/session-start-hook.mjs");
      const hookOutPopulated = await new Promise((resolveHook, rejectHook) => {
        const cp = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", hookPath], {
          env: { ...process.env, SAVE_TOKEN_DB_PATH: dbPath },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        cp.stdout.on("data", (d) => (out += d.toString()));
        cp.stderr.on("data", (d) => (err += d.toString()));
        cp.on("close", (code) => (code === 0 ? resolveHook({ out, err }) : rejectHook(new Error(`Hook exited ${code}: ${err}`))));
        cp.stdin.end(JSON.stringify({ cwd: tempRoot, workspacePaths: [tempRoot] }));
      });
      const hookJson = JSON.parse(hookOutPopulated.out);
      const sysMsg = hookJson.injectSteps?.[0]?.systemMessage?.systemMessage || "";
      assert.match(sysMsg, /\[Save Token External Cache\]/);
      assert.match(sysMsg, /hud-ui/);
      assert.match(sysMsg, /auth-flow/);

      const hookOutMissing = await new Promise((resolveHook, rejectHook) => {
        const cp = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", hookPath], {
          env: { ...process.env, SAVE_TOKEN_DB_PATH: path.join(tempRoot, "missing.db") },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        cp.stdout.on("data", (d) => (out += d.toString()));
        cp.on("close", (code) => (code === 0 ? resolveHook(out) : rejectHook(new Error(`Hook missing DB exited ${code}`))));
        cp.stdin.end("{}");
      });
      assert.deepEqual(JSON.parse(hookOutMissing), {});

      assert.equal(server5.client.stderrBuf, "", `Server 5 stderr: ${server5.client.stderrBuf}`);
    } finally {
      await stopServer(server5.proc);
    }
    console.log("PASS Test 17: Shared branch/tag isolation, progress.md & SessionStart hook");

    // Test 18: Zero-LLM auto-inference of branch & tags (git branch, Vietnamese prompt, touchedFiles, explicit priority)
    const server6 = startServer(dbPath, {
      ANTIGRAVITY_BRAIN_DIR: mockBrain,
      SAVE_TOKEN_DISTILL_DIR: path.join(tempRoot, "distilled"),
    });
    try {
      await server6.client.request("initialize", {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "save-token-test-6", version: "1.0.0" },
      });
      server6.client.notify("notifications/initialized", {});

      const gitProjDir = path.join(tempRoot, "git-proj");
      await fs.mkdir(path.join(gitProjDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(gitProjDir, ".git", "HEAD"), "ref: refs/heads/feat/oauth-refresh\n", "utf8");

      const convAutoGit = "eeeeeeee-1111-4444-8888-eeeeeeee1111";
      const gitConvLog = path.join(mockBrain, convAutoGit, ".system_generated", "logs");
      await fs.mkdir(gitConvLog, { recursive: true });
      await fs.writeFile(
        path.join(gitConvLog, "transcript.jsonl"),
        [
          JSON.stringify({
            type: "USER_INPUT",
            userInput: {
              items: [{ text: "Toi can toi uu cache cho sidecar HUD va MCP hooks" }],
              media: [],
              contextItems: [{ absolutePath: path.join(gitProjDir, "sidecars", "context-hud", "main.mjs") }],
            },
          }),
          JSON.stringify({ type: "PLANNER_RESPONSE", response: "Da cap nhat HUD va hooks." }),
        ].join("\n") + "\n",
        "utf8"
      );

      const hdGit = await server6.client.callTool("save_token_handoff", {
        conversationId: convAutoGit,
        project: gitProjDir,
      });
      assert.equal(hdGit.isError, false);
      const hdGitJson = JSON.parse(hdGit.content[0].text);
      assert.equal(hdGitJson.branch, "feat-oauth-refresh");
      assert.equal(hdGitJson.branchInferred, true);
      assert.equal(hdGitJson.branchSource, "git");
      assert.ok(Array.isArray(hdGitJson.tags) && hdGitJson.tags.includes("hud"));
      assert.equal(hdGitJson.tagsInferred, true);

      // Vietnamese prompt + no git branch -> prompt slug + file tags, while explicit branch wins
      const noGitProj = path.join(tempRoot, "finchat-app");
      await fs.mkdir(noGitProj, { recursive: true });
      const hdPrompt = await server6.client.callTool("save_token_handoff", {
        title: "Sửa lỗi đăng nhập OTP cho ứng dụng",
        project: noGitProj,
        goal: "Khắc phục timeout OTP",
      });
      const hdPromptJson = JSON.parse(hdPrompt.content[0].text);
      assert.notEqual(hdPromptJson.branch, "main");
      assert.match(hdPromptJson.branch, /finchat-app/);
      assert.equal(hdPromptJson.branchInferred, true);
      assert.equal(hdPromptJson.branchSource, "prompt");

      const hdExplicit = await server6.client.callTool("save_token_handoff", {
        title: "Keep explicit branch",
        project: gitProjDir,
        branch: "custom-manual",
        tags: ["alpha", "beta", "gamma"],
      });
      const hdExplicitJson = JSON.parse(hdExplicit.content[0].text);
      assert.equal(hdExplicitJson.branch, "custom-manual");
      assert.equal(hdExplicitJson.branchInferred, false);
      assert.deepEqual(hdExplicitJson.tags, ["alpha", "beta", "gamma"]);
      assert.equal(hdExplicitJson.tagsInferred, false);
      console.log("PASS Test 18: 0-LLM branch/tag auto-inference & explicit priority");

      // Test 19: tools.outline & tools.readSymbol across JS, Python, Markdown, JSON
      const outlineDir = path.join(tempRoot, "outline-sample");
      await fs.mkdir(outlineDir, { recursive: true });
      await fs.writeFile(
        path.join(outlineDir, "app.mjs"),
        [
          "export function alphaHelper(x) {",
          "  const msg = '{not-a-brace}';",
          "  return x + 1;",
          "}",
          "",
          "export class TokenEngine {",
          "  compute(a, b) {",
          "    if (a > 0) { return a + b; }",
          "    return 0;",
          "  }",
          "}",
        ].join("\n"),
        "utf8"
      );
      await fs.writeFile(
        path.join(outlineDir, "worker.py"),
        ["class Worker:", "    def run_task(self, x):", "        return x * 2", "", "def standalone(y):", "    return y + 3"].join("\n"),
        "utf8"
      );
      await fs.writeFile(
        path.join(outlineDir, "guide.md"),
        ["# Overview", "intro", "## Usage", "details here", "### Advanced", "more"].join("\n"),
        "utf8"
      );
      await fs.writeFile(
        path.join(outlineDir, "config.json"),
        JSON.stringify({ name: "demo", items: [1, 2, 3], meta: { ok: true } }, null, 2),
        "utf8"
      );

      const t19 = await server6.client.callTool("save_token_exec", {
        cwd: outlineDir,
        code: `
          const jsOut = await tools.outline("app.mjs");
          const pyOut = await tools.outline("worker.py");
          const mdOut = await tools.outline("guide.md");
          const jsonOut = await tools.outline("config.json");
          const sym = await tools.readSymbol("app.mjs", "compute", { contextLines: 0 });
          const miss = await tools.readSymbol("app.mjs", "nonExistentFn");
          return { jsOut, pyOut, mdOut, jsonOut, sym, miss };
        `,
      });
      assert.equal(t19.isError, false);
      const t19Json = JSON.parse(t19.content[0].text.split(/\n\[save-token/)[0]);
      assert.ok(t19Json.jsOut.symbols.some((s) => s.name === "alphaHelper" && s.line === 1 && s.endLine === 4));
      assert.ok(t19Json.jsOut.symbols.some((s) => s.kind === "method" && s.name === "compute"));
      assert.ok(!t19Json.jsOut.symbols.some((s) => s.name === "if"));
      assert.ok(t19Json.pyOut.symbols.some((s) => s.name === "run_task") && t19Json.pyOut.symbols.some((s) => s.name === "standalone"));
      assert.ok(t19Json.mdOut.symbols.some((s) => s.kind === "h2" && s.name === "Usage"));
      assert.ok(t19Json.jsonOut.symbols.some((s) => s.name === "items" && s.kind === "array(3)"));
      assert.equal(t19Json.sym.found, true);
      assert.match(t19Json.sym.code, /compute\(a, b\)/);
      assert.doesNotMatch(t19Json.sym.code, /alphaHelper/);
      assert.equal(t19Json.miss.found, false);
      console.log("PASS Test 19: tools.outline & tools.readSymbol (JS/Py/MD/JSON)");

      // Test 20: compact-engine.mjs, compact-shell.mjs (--b64 + exitCode), & pre-tool-guard-hook.mjs
      const scriptsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../scripts");
      const { compactOutput } = await import(pathToFileURL(path.join(scriptsDir, "compact-engine.mjs")).href);
      const { evaluatePreToolUse } = await import(pathToFileURL(path.join(scriptsDir, "pre-tool-guard-hook.mjs")).href);

      const rawDiff = [
        "diff --git a/src/a.js b/src/a.js",
        "--- a/src/a.js",
        "+++ b/src/a.js",
        "@@ -1,2 +1,2 @@",
        "-oldLine",
        "+newLine",
      ].join("\n");
      const cDiff = compactOutput(rawDiff, { kind: "git-diff" });
      assert.match(cDiff, /Diff summary: 1 file\(s\), \+1 -1/);

      const rawLog = [
        "commit abcdef1234567890",
        "Author: Dev <dev@example.com>",
        "Date:   2026-11-27",
        "",
        "    feat: compact logs",
      ].join("\n");
      const cLog = compactOutput(rawLog, { kind: "git-log" });
      assert.match(cLog, /^abcdef12.*feat: compact logs/);

      const compactShellPath = path.join(scriptsDir, "compact-shell.mjs");
      const runCompactShell = (cmd) =>
        new Promise((resolveShell) => {
          const b64 = Buffer.from(cmd, "utf8").toString("base64");
          const cp = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", compactShellPath, "--b64", b64], {
            env: { ...process.env, SAVE_TOKEN_DB_PATH: dbPath },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          let err = "";
          cp.stdout.on("data", (d) => (out += d.toString()));
          cp.stderr.on("data", (d) => (err += d.toString()));
          cp.on("close", (code) => resolveShell({ code, out, err }));
        });

      const okCmd = `node -e "for(let i=0;i<60;i++)console.log('ok '+i);console.log('Tests: 60 passed');"`;
      const resOk = await runCompactShell(okCmd);
      assert.equal(resOk.code, 0);
      assert.match(resOk.out, /collapsed 60 passing/);
      assert.match(resOk.out, /save-token compact:.*exit=0/);

      const failCmd = `node -e "for(let i=0;i<50;i++)console.log('ok '+i);console.error('FAIL assertion');process.exit(1);"`;
      const resFail = await runCompactShell(failCmd);
      assert.equal(resFail.code, 1);
      assert.match(resFail.out, /FAIL assertion/);
      assert.match(resFail.out, /exit=1/);

      // PreToolUse hook checks (use isolated env so tests never touch user home)
      const preToolEnv = { ...process.env, SAVE_TOKEN_DB_PATH: path.join(tempRoot, "pretool-store.db") };
      const denyTranscript = evaluatePreToolUse(
        { toolCall: { name: "read_file", args: { Path: "C:/logs/.system_generated/logs/transcript_full.jsonl" } } },
        preToolEnv
      );
      assert.equal(denyTranscript.decision, "deny");

      const largeTxtPath = path.join(tempRoot, "big.txt");
      await fs.writeFile(largeTxtPath, "A".repeat(40 * 1024), "utf8");
      const clampLarge = evaluatePreToolUse(
        { conversationId: "t20-clamp", toolCall: { name: "read_file", args: { Path: largeTxtPath } } },
        preToolEnv
      );
      assert.equal(clampLarge.decision, "allow");
      assert.deepEqual(clampLarge.overwrite, { StartLine: 1, EndLine: 150 });

      const keepRange = evaluatePreToolUse(
        { conversationId: "t20-range", toolCall: { name: "read_file", args: { Path: largeTxtPath, StartLine: 10, EndLine: 50 } } },
        preToolEnv
      );
      assert.equal(keepRange.overwrite, undefined);

      const rwCmd = evaluatePreToolUse({
        toolCall: { name: "run_command", args: { CommandLine: "git status" } },
      });
      assert.equal(rwCmd.decision, "allow");
      assert.match(rwCmd.overwrite?.CommandLine || "", /compact-shell\.mjs.*--b64/);

      const skipPipe = evaluatePreToolUse({
        toolCall: { name: "run_command", args: { CommandLine: "git status | grep foo" } },
      });
      assert.equal(skipPipe.overwrite, undefined);

      const skipDaemon = evaluatePreToolUse({
        toolCall: { name: "run_command", args: { CommandLine: "npm test", IsDaemon: true } },
      });
      assert.equal(skipDaemon.overwrite, undefined);

      // Fail-open on malformed stdin
      const hookProcRes = await new Promise((resolveHp) => {
        const cp = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", path.join(scriptsDir, "pre-tool-guard-hook.mjs")], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        cp.stdout.on("data", (d) => (out += d.toString()));
        cp.on("close", (code) => resolveHp({ code, out }));
        cp.stdin.end("{bad-json");
      });
      assert.equal(hookProcRes.code, 0);
      assert.equal(JSON.parse(hookProcRes.out).decision, "allow");

      console.log("PASS Test 20: compact-engine, compact-shell & PreToolUse guard hook");

      // Test 21: hooks.json removes PreInvocation, Stop idle-auto 0-LLM snapshot & SessionStart auto-load
      const hooksJson = JSON.parse(
        await fs.readFile(path.resolve(__dirname, "../hooks.json"), "utf8")
      );
      assert.equal(Object.hasOwn(hooksJson, "save-token-model-switch-guard"), false);
      assert.equal(
        JSON.stringify(hooksJson).includes("PreInvocation"),
        false,
        "hooks.json must not contain PreInvocation"
      );
      assert.ok(hooksJson["save-token-idle-snapshot"]?.Stop?.length === 1);

      const { evaluateStopIdle } = await import(
        pathToFileURL(path.join(scriptsDir, "stop-idle-snapshot-hook.mjs")).href
      );
      const stopDb = path.join(tempRoot, "stop-idle-store.db");
      const stopProj = path.join(tempRoot, "idle-snapshot-app");
      await fs.mkdir(stopProj, { recursive: true });
      const stopEnv = {
        ...process.env,
        SAVE_TOKEN_DB_PATH: stopDb,
        SAVE_TOKEN_DISTILL_DIR: path.join(tempRoot, "stop-distilled"),
        SAVE_TOKEN_IDLE_THRESHOLD: "100000",
      };

      const heavyStopTranscript = path.join(tempRoot, "stop_heavy_transcript.jsonl");
      await fs.writeFile(
        heavyStopTranscript,
        [
          JSON.stringify({
            step_index: 10,
            type: "USER_INPUT",
            source: "USER_EXPLICIT",
            content: "<USER_REQUEST>\nToi uu cache va theo doi han muc 5h/7d\n</USER_REQUEST>",
          }),
          JSON.stringify({
            step_index: 120,
            type: "PLANNER_RESPONSE",
            model: "gemini-4-neon-high",
            input_tokens: 15000,
            cache_read_tokens: 145000,
            content: "Da hoan tat nâng cap save-token HUD.",
            tool_calls: [{ name: "edit_file", args: { Path: path.join(stopProj, "sidecars/context-hud/main.mjs") } }],
          }),
        ].join("\n") + "\n",
        "utf8"
      );

      // Case 1: Non-idle / running / continuationActive turns MUST skip and never create handoff
      for (const nonIdlePayload of [
        { conversationId: "conv-stop-1", transcriptPath: heavyStopTranscript, terminationReason: "TOOL_CALL", fullyIdle: false },
        { conversationId: "conv-stop-1", transcriptPath: heavyStopTranscript, terminationReason: "NO_TOOL_CALL", fullyIdle: false },
        { conversationId: "conv-stop-1", transcriptPath: heavyStopTranscript, terminationReason: "NO_TOOL_CALL", fullyIdle: true, continuationActive: true },
      ]) {
        const resNonIdle = await evaluateStopIdle(nonIdlePayload, stopEnv);
        assert.deepEqual(resNonIdle, {});
      }
      await assert.rejects(fs.access(stopDb));

      // Case 2: Truly idle 160k session saves 0-LLM snapshot tagged 'idle-auto' and returns {}
      const resIdle = await evaluateStopIdle(
        {
          conversationId: "conv-stop-1",
          transcriptPath: heavyStopTranscript,
          cwd: stopProj,
          workspacePaths: [stopProj],
          terminationReason: "NO_TOOL_CALL",
          fullyIdle: true,
          continuationActive: false,
        },
        stopEnv
      );
      assert.deepEqual(resIdle, {});

      const checkStopDb = new DatabaseSync(stopDb, { readOnly: true });
      const rowsAfterFirst = checkStopDb.prepare("SELECT id, branch, tags_json FROM handoffs ORDER BY created_at DESC").all();
      checkStopDb.close();
      assert.equal(rowsAfterFirst.length, 1);
      assert.ok(JSON.parse(rowsAfterFirst[0].tags_json).includes("idle-auto"));

      // Case 3: Dedup at same stepIndex (120) must NOT write a duplicate snapshot
      const resDup = await evaluateStopIdle(
        {
          conversationId: "conv-stop-1",
          transcriptPath: heavyStopTranscript,
          terminationReason: "NO_TOOL_CALL",
          fullyIdle: true,
        },
        stopEnv
      );
      assert.deepEqual(resDup, {});
      const checkDupDb = new DatabaseSync(stopDb, { readOnly: true });
      const countAfterDup = checkDupDb.prepare("SELECT COUNT(*) AS c FROM handoffs").get().c;
      checkDupDb.close();
      assert.equal(countAfterDup, 1);

      // Case 4: Transcript with trailing CHECKPOINT after last planner step must skip
      const ckptTranscript = path.join(tempRoot, "stop_ckpt_transcript.jsonl");
      await fs.writeFile(
        ckptTranscript,
        [
          JSON.stringify({ step_index: 50, type: "PLANNER_RESPONSE", model: "gemini-4-neon", input_tokens: 10000, cache_read_tokens: 150000, content: "ok" }),
          JSON.stringify({ step_index: 51, type: "CHECKPOINT", content: "compacted" }),
        ].join("\n") + "\n",
        "utf8"
      );
      await evaluateStopIdle(
        { conversationId: "conv-stop-ckpt", transcriptPath: ckptTranscript, terminationReason: "NO_TOOL_CALL", fullyIdle: true },
        stopEnv
      );
      const checkCkptDb = new DatabaseSync(stopDb, { readOnly: true });
      const countAfterCkpt = checkCkptDb.prepare("SELECT COUNT(*) AS c FROM handoffs").get().c;
      checkCkptDb.close();
      assert.equal(countAfterCkpt, 1);

      // Case 5: SessionStart auto-loads fresh idle-auto snapshot inline (<=2600 chars)
      const ssRes = await new Promise((resolveHook, rejectHook) => {
        const cp = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", path.join(scriptsDir, "session-start-hook.mjs")], {
          env: { ...process.env, SAVE_TOKEN_DB_PATH: stopDb },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        cp.stdout.on("data", (d) => (out += d.toString()));
        cp.stderr.on("data", (d) => (err += d.toString()));
        cp.on("close", (code) => (code === 0 ? resolveHook({ out, err }) : rejectHook(new Error(`SessionStart exited ${code}: ${err}`))));
        cp.stdin.end(JSON.stringify({ cwd: stopProj, workspacePaths: [stopProj] }));
      });
      const ssMsg = JSON.parse(ssRes.out).injectSteps?.[0]?.systemMessage?.systemMessage || "";
      assert.match(ssMsg, /\[Save Token External Cache\]/);
      assert.match(ssMsg, /\[Auto-Loaded Snapshot:/);
      assert.match(ssMsg, /idle-auto/);
      assert.ok(ssMsg.length <= 2600, `Expected <= 2600 chars, got ${ssMsg.length}`);

      // Case 6: Stop hook CLI fails open on bad JSON
      const stopProc = await new Promise((resolveStop) => {
        const cp = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", path.join(scriptsDir, "stop-idle-snapshot-hook.mjs")], {
          env: { ...stopEnv, SAVE_TOKEN_IDLE_SNAPSHOT_MODE: "off" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        cp.stdout.on("data", (d) => (out += d.toString()));
        cp.on("close", (code) => resolveStop({ code, out }));
        cp.stdin.end("{broken-json");
      });
      assert.equal(stopProc.code, 0);
      assert.deepEqual(JSON.parse(stopProc.out), {});

      console.log("PASS Test 21: hooks.json Stop idle-auto 0-LLM snapshot & SessionStart auto-load");

      // Test 22: RTK + Caveman upgrades & 5 architecture enhancements
      const { compactStructuredData, applyFilterRules, stripSourceComments } = await import(
        pathToFileURL(path.join(scriptsDir, "compact-engine.mjs")).href
      );
      const { distillTranscriptFile } = await import(
        pathToFileURL(path.join(scriptsDir, "distill-chat.mjs")).href
      );

      // 22a: Structured JSON compression with invariants (valid JSON + idempotent)
      const bigRows = Array.from({ length: 30 }, (_, idx) => ({
        id: idx + 1,
        latencyMs: 10 + idx * 5,
        status: idx % 3 === 0 ? "warn" : "ok",
        tag: null,
      }));
      const shrunkJsonStr = compactStructuredData(JSON.stringify(bigRows));
      const shrunkJson = JSON.parse(shrunkJsonStr);
      assert.equal(shrunkJson.length, 6);
      assert.equal(shrunkJson[3].__elided__, 25);
      assert.equal(shrunkJson[3].__invariants__.numericRanges.latencyMs.min, 25);
      assert.equal(shrunkJson[3].__invariants__.numericRanges.latencyMs.max, 145);
      assert.ok(Array.isArray(shrunkJson[3].__invariants__.smallEnums.status));
      assert.equal(compactStructuredData(shrunkJsonStr), shrunkJsonStr, "JSON compressor must be idempotent");

      // 22b: CSV summary & search grouping & string-aware comment stripping
      const csvRows = ["id,latency,env", ...Array.from({ length: 20 }, (_, i) => `${i + 1},${100 + i},${i % 2 === 0 ? "prod" : "staging"}`)].join("\n");
      const csvOut = compactStructuredData(csvRows, { kind: "csv" });
      assert.match(csvOut, /Tabular summary: 20 rows, 3 columns/);
      assert.match(csvOut, /latency: num \[100\.\.119\]/);

      const searchLines = Array.from({ length: 14 }, (_, i) => `src/mod${i % 2}.mjs:${i + 10}: const tokenHit = ${i};`).join("\n");
      const searchCompact = compactOutput(searchLines);
      assert.match(searchCompact, /Search summary: 14 matches across 2 file\(s\)/);

      const customRules = [
        {
          name: "my-build",
          match_command: "^npm run custom-build",
          strip_ansi: true,
          match_output: [{ pattern: "Build succeeded", unless: "ERROR:", message: "ok (custom-build)" }],
          strip_lines: ["^Downloading"],
          max_lines: 20,
        },
      ];
      const okFilter = applyFilterRules("Downloading x\nBuild succeeded in 1s", "npm run custom-build", customRules);
      assert.equal(okFilter.text, "ok (custom-build)");
      const errFilter = applyFilterRules("Downloading x\nERROR: failed\nBuild succeeded", "npm run custom-build", customRules);
      assert.notEqual(errFilter.shortCircuited, true);
      assert.match(errFilter.text, /ERROR: failed/);

      const pyCode = [
        'QUERY = """ # keep hash inside triple string',
        'SELECT 1',
        '"""',
        "# strip top comment",
        "x = 42  # strip inline comment",
      ].join("\n");
      const pyStripped = stripSourceComments(pyCode, "sample.py");
      assert.match(pyStripped, /# keep hash inside triple string/);
      assert.doesNotMatch(pyStripped, /strip top comment/);
      assert.match(pyStripped, /x = 42$/m);

      // 22c: Tee-on-Failure writes 100% raw output log on non-zero exit when output is compacted
      const teeCmd = `node -e "for(let i=0;i<80;i++)console.log('ok step '+i+' padded verbose test noise line for compaction check');console.error('CRITICAL_TEE_TOKEN');process.exit(1);"`;
      const teeRes = await runCompactShell(teeCmd);
      assert.equal(teeRes.code, 1);
      const fullMatch = teeRes.out.match(/\| full=([^\]]+)/);
      assert.ok(fullMatch, `Expected full=... tee hint in output: ${teeRes.out}`);
      const teeContent = await fs.readFile(fullMatch[1].trim(), "utf8");
      assert.match(teeContent, /CRITICAL_TEE_TOKEN/);
      assert.match(teeContent, /ok step 79/);

      // 22d: Read-Dedup Guard (allow 1st -> deny repeat -> allow 2nd try -> allow after file change)
      const dedupTarget = path.join(tempRoot, "dedup-sample.txt");
      await fs.writeFile(dedupTarget, "L1\n".repeat(3000), "utf8");
      const dedupEnv = { ...process.env, SAVE_TOKEN_DB_PATH: path.join(tempRoot, "dedup-store.db") };
      const r1 = evaluatePreToolUse(
        { conversationId: "conv-dedup", toolCall: { name: "read_file", args: { Path: dedupTarget, StartLine: 1, EndLine: 80 } } },
        dedupEnv
      );
      assert.equal(r1.decision, "allow");
      const r2 = evaluatePreToolUse(
        { conversationId: "conv-dedup", toolCall: { name: "read_file", args: { Path: dedupTarget, StartLine: 10, EndLine: 40 } } },
        dedupEnv
      );
      assert.equal(r2.decision, "deny");
      assert.match(r2.reason || "", /read-dedup/);
      const r3 = evaluatePreToolUse(
        { conversationId: "conv-dedup", toolCall: { name: "read_file", args: { Path: dedupTarget, StartLine: 10, EndLine: 40 } } },
        dedupEnv
      );
      assert.equal(r3.decision, "allow");
      await fs.writeFile(dedupTarget, "CHANGED\n" + "L2\n".repeat(3005), "utf8");
      const r4 = evaluatePreToolUse(
        { conversationId: "conv-dedup", toolCall: { name: "read_file", args: { Path: dedupTarget, StartLine: 1, EndLine: 80 } } },
        dedupEnv
      );
      assert.equal(r4.decision, "allow");

      // 22e: save_token_exec tools.repoMap (PageRank), tools.compactData, tools.stripComments
      const mapRepoDir = path.join(tempRoot, "mini-repo");
      await fs.mkdir(mapRepoDir, { recursive: true });
      await fs.writeFile(path.join(mapRepoDir, "core.mjs"), "export function sharedCore() { return 1; }\n", "utf8");
      await fs.writeFile(path.join(mapRepoDir, "a.mjs"), "import { sharedCore } from './core.mjs';\nexport function fnA() { return sharedCore(); }\n", "utf8");
      await fs.writeFile(path.join(mapRepoDir, "b.mjs"), "import { sharedCore } from './core.mjs';\nexport function fnB() { return sharedCore(); }\n", "utf8");
      await fs.writeFile(path.join(mapRepoDir, "leaf.mjs"), "export function isolatedLeaf() { return 0; }\n", "utf8");

      const execMapRes = await server6.client.request("tools/call", {
        name: "save_token_exec",
        arguments: {
          mode: "readonly",
          code: `
            const rm = await tools.repoMap(${JSON.stringify(mapRepoDir)}, { focusFiles: ["a.mjs"] });
            const cd = tools.compactData(${JSON.stringify(bigRows)});
            const sc = tools.stripComments("// header\\nconst v = 'http://x';", "test.js");
            return { edgeCount: rm.edgeCount, top2: rm.files.slice(0, 2).map(f => f.path), mapTextHead: rm.text.split("\\n")[0], cdValid: JSON.parse(cd).length === 6, sc };
          `,
        },
      });
      const parsedMapRes = JSON.parse(execMapRes.result.content[0].text.split("\n[save-token")[0]);
      assert.equal(parsedMapRes.edgeCount, 2);
      assert.equal(parsedMapRes.top2[0], "a.mjs");
      assert.ok(parsedMapRes.top2.includes("core.mjs"));
      assert.equal(parsedMapRes.cdValid, true);
      assert.equal(parsedMapRes.sc, "const v = 'http://x';");

      // 22f: Anchored Delta Distiller incremental merge preserves step 1 goal & merges new decisions/tests
      const anchorCacheDir = path.join(tempRoot, "anchor-distill");
      const anchorTranscript = path.join(tempRoot, "anchor_transcript.jsonl");
      await fs.writeFile(
        anchorTranscript,
        [
          JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "<USER_REQUEST>\nXay dung module xac thuc JWT\n</USER_REQUEST>" }),
          JSON.stringify({ step_index: 2, type: "PLANNER_RESPONSE", content: "Đã chọn hướng dùng thư viện chuẩn, bỏ qua session cookie." }),
        ].join("\n") + "\n",
        "utf8"
      );
      const d1 = await distillTranscriptFile(anchorTranscript, { conversationId: "conv-anchor-1", cacheDir: anchorCacheDir });
      assert.equal(d1.anchored.lastStepIndex, 2);
      await fs.appendFile(
        anchorTranscript,
        [
          JSON.stringify({ step_index: 3, type: "PLANNER_RESPONSE", content: "Đã hoàn tất hàm `verifyJwtToken` và chạy test.", tool_calls: [{ name: "edit_file", args: { Path: path.join(mapRepoDir, "auth.mjs") } }] }),
          JSON.stringify({ step_index: 4, type: "GENERIC", content: "ALL 12 TESTS PASSED" }),
        ].join("\n") + "\n",
        "utf8"
      );
      const d2 = await distillTranscriptFile(anchorTranscript, { conversationId: "conv-anchor-1", cacheDir: anchorCacheDir });
      assert.equal(d2.anchored.lastStepIndex, 4);
      assert.equal(d2.anchored.deltaSteps, 2);
      assert.match(d2.summaryMd, /Xay dung module xac thuc JWT/);
      assert.match(d2.summaryMd, /Phương án đã loại/);
      assert.match(d2.summaryMd, /ALL 12 TESTS PASSED/);

      console.log("PASS Test 22: RTK+Caveman compression, Tee-on-Failure, Read-Dedup, RepoMap & Anchored Delta Distiller");
      assert.equal(server6.client.stderrBuf, "", `Server 6 stderr: ${server6.client.stderrBuf}`);

      // Test 23: v1.3.0 Multi-platform hooks, TOON encoder, CCR receipt, Claude/Codex transcripts, inferBranch & storage-paths
      const { encodeToon } = await import(pathToFileURL(path.resolve(__dirname, "../scripts/compact-engine.mjs")).href);
      const { buildSessionStartOutput } = await import(pathToFileURL(path.resolve(__dirname, "../scripts/session-start-hook.mjs")).href);
      const { inferBranch } = await import(pathToFileURL(path.resolve(__dirname, "../scripts/context-meta.mjs")).href);
      const { resolveDbPath } = await import(pathToFileURL(path.resolve(__dirname, "../scripts/storage-paths.mjs")).href);

      // 23a: TOON lossless tabular encoding & tools.toToon
      const toonRows = Array.from({ length: 15 }, (_, i) => ({
        id: i + 1,
        name: i === 2 ? "Alice, Sr:Ops" : `User${i + 1}`,
        role: i % 2 === 0 ? "admin" : "viewer",
        active: i % 3 !== 0,
      }));
      const toonText = encodeToon({ users: toonRows });
      const rawJsonText = JSON.stringify({ users: toonRows }, null, 2);
      assert.ok(toonText.length < rawJsonText.length * 0.65, `Expected TOON < 65% of JSON (${toonText.length} vs ${rawJsonText.length})`);
      assert.match(toonText, /users\[15\]\{id,name,role,active\}:/);
      assert.match(toonText, /"Alice, Sr:Ops"/);

      const mcpToonRes = await server6.client.callTool("save_token_exec", {
        code: `
          const rows = Array.from({ length: 6 }, (_, i) => ({ id: i, tag: "t" + i }));
          return tools.toToon(rows);
        `,
      });
      const mcpToonText = mcpToonRes.content.map((c) => c.text).join("\n");
      assert.match(mcpToonText, /\[6\]\{id,tag\}:/);

      // 23b: Reversible CCR receipt on exit=0 heavily compressed output (>= 8KB, >= 50%)
      const ccrDbDir = path.join(tempRoot, "ccr-test");
      await fs.mkdir(ccrDbDir, { recursive: true });
      const compactShellScript = path.resolve(__dirname, "../scripts/compact-shell.mjs");
      const ccrCmd = "node -e \"for(let i=0;i<320;i++)console.log('ok step_verification_line_item_' + i + ' elapsed=2ms status=passed')\"";
      const ccrB64 = Buffer.from(ccrCmd, "utf8").toString("base64");
      const ccrRun = await execFileAsync(process.execPath, ["--no-warnings=ExperimentalWarning", compactShellScript, "--b64", ccrB64], {
        env: { ...process.env, SAVE_TOKEN_DB_PATH: path.join(ccrDbDir, "store.db") },
      });
      assert.match(ccrRun.stdout, /\| exit=0 /);
      const ccrFullMatch = ccrRun.stdout.match(/\| full=([^\s\]]+)/);
      assert.ok(ccrFullMatch, `Expected reversible CCR receipt path in: ${ccrRun.stdout}`);
      const ccrLogText = await fs.readFile(ccrFullMatch[1], "utf8");
      assert.match(ccrLogText, /# exit: 0/);
      assert.match(ccrLogText, /# saved:/);

      // 23c: Cross-platform PreToolUse (Claude Code, Gemini CLI, Cursor)
      const claudeEnv = {
        ...process.env,
        SAVE_TOKEN_DB_PATH: path.join(tempRoot, "claude-hook-data", "store.db"),
        SAVE_TOKEN_NO_COMPACT: "0",
      };
      const claudeBash = evaluatePreToolUse(
        { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, session_id: "c-sess-1" },
        claudeEnv
      );
      assert.equal(claudeBash.hookSpecificOutput?.permissionDecision, "allow");
      assert.match(claudeBash.hookSpecificOutput?.updatedInput?.command || "", /compact-shell\.mjs/);

      const claudeBigFile = path.join(tempRoot, "claude_big.txt");
      await fs.writeFile(claudeBigFile, "line\n".repeat(9000), "utf8");
      const claudeRead1 = evaluatePreToolUse(
        { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: claudeBigFile }, session_id: "c-sess-1" },
        claudeEnv
      );
      assert.equal(claudeRead1.hookSpecificOutput?.updatedInput?.offset, 1);
      assert.equal(claudeRead1.hookSpecificOutput?.updatedInput?.limit, 150);
      const claudeReadDup = evaluatePreToolUse(
        { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: claudeBigFile, offset: 1, limit: 100 }, session_id: "c-sess-1" },
        claudeEnv
      );
      assert.equal(claudeReadDup.hookSpecificOutput?.permissionDecision, "deny");

      const geminiDeny = evaluatePreToolUse(
        { hook_event_name: "BeforeTool", tool_name: "read_file", tool_input: { path: "/tmp/.system_generated/logs/transcript.jsonl" } },
        claudeEnv
      );
      assert.equal(geminiDeny.decision, "deny");
      assert.equal(evaluatePreToolUse({ hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "ls" } }, claudeEnv).decision, "allow");

      const cursorDeny = evaluatePreToolUse(
        { hook_event_name: "preToolUse", tool_name: "read_file", tool_input: { file_path: "/tmp/.system_generated/logs/transcript.jsonl" } },
        claudeEnv
      );
      assert.equal(cursorDeny.permission, "deny");

      // 23d: Cross-platform SessionStart output (Claude/Gemini vs Antigravity)
      const ssDbPath = path.join(tempRoot, "ss-multi", "store.db");
      await fs.mkdir(path.dirname(ssDbPath), { recursive: true });
      const { createHandoffStore } = await import(pathToFileURL(path.resolve(__dirname, "../sidecars/context-hud/handoff-store.mjs")).href);
      const ssStore = createHandoffStore({ dbPath: ssDbPath, handoffDir: path.join(path.dirname(ssDbPath), "handoffs"), progressDir: path.join(path.dirname(ssDbPath), "progress") });
      ssStore.saveHandoff({ conversationId: "ss-conv-1", title: "Multi test", project: mapRepoDir, branch: "feat-multi", tags: ["mcp"], summaryMd: "# Summary\nReady" });
      ssStore.close();

      const ssClaude = buildSessionStartOutput({ hook_event_name: "SessionStart", session_id: "c1", cwd: mapRepoDir }, { SAVE_TOKEN_DB_PATH: ssDbPath });
      assert.equal(ssClaude.hookSpecificOutput?.hookEventName, "SessionStart");
      assert.match(ssClaude.hookSpecificOutput?.additionalContext || "", /\[Save Token External Cache\]/);

      const ssAgy = buildSessionStartOutput({ workspacePaths: [mapRepoDir] }, { SAVE_TOKEN_DB_PATH: ssDbPath });
      assert.match(ssAgy.injectSteps?.[0]?.systemMessage?.systemMessage || "", /\[Save Token External Cache\]/);

      // 23e: Multi-format Distiller for Claude Code & Codex CLI JSONL transcripts
      const claudeLog = path.join(tempRoot, "claude_transcript.jsonl");
      await fs.writeFile(
        claudeLog,
        [
          JSON.stringify({ type: "user", timestamp: "2026-11-27T10:00:00Z", message: { role: "user", content: "Build Stripe webhook verification" } }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-27T10:00:05Z",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Đã chốt dùng HMAC SHA-256, tránh tin header thô chưa verify." },
                { type: "tool_use", name: "Edit", input: { file_path: "/proj/src/pay.ts" } },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "tool_result", is_error: true, content: "Invalid Stripe signature" }] },
          }),
        ].join("\n") + "\n",
        "utf8"
      );
      const claudeDistill = await distillTranscriptFile(claudeLog, { conversationId: "claude-conv-1", cacheDir: path.join(tempRoot, "distill-multi"), noCache: true });
      assert.match(claudeDistill.summaryMd, /Build Stripe webhook verification/);
      assert.match(claudeDistill.summaryMd, /HMAC SHA-256/);
      assert.match(claudeDistill.summaryMd, /\/proj\/src\/pay\.ts/);
      assert.match(claudeDistill.summaryMd, /Invalid Stripe signature/);

      const codexLog = path.join(tempRoot, "codex_transcript.jsonl");
      await fs.writeFile(
        codexLog,
        [
          JSON.stringify({ type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Optimize worker queue throughput" }] } }),
          JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "write_file", arguments: JSON.stringify({ file_path: "/proj/src/queue.ts" }) } }),
          JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Đã hoàn tất cấu hình hàng đợi batch worker." } }),
        ].join("\n") + "\n",
        "utf8"
      );
      const codexDistill = await distillTranscriptFile(codexLog, { conversationId: "codex-conv-1", cacheDir: path.join(tempRoot, "distill-multi"), noCache: true });
      assert.match(codexDistill.summaryMd, /Optimize worker queue throughput/);
      assert.match(codexDistill.summaryMd, /\/proj\/src\/queue\.ts/);

      // 23f: inferBranch ignores save_token_resume / UUID noise
      const cleanBr = inferBranch({
        project: "/tmp/save-token",
        firstUserPrompt: 'save_token_resume({ conversationId: "1be32221-3360-44c4-a5d8-657ee483e8aa" })',
        touchedFiles: ["/tmp/save-token/server/save-token-mcp.mjs"],
      });
      assert.ok(!/resume|conversationid|1be32221/i.test(cleanBr.branch), `Unexpected noisy branch: ${cleanBr.branch}`);
      assert.equal(cleanBr.branch, "save-token-server");

      // 23g: storage-paths Antigravity vs non-Antigravity resolution
      const noAgyHome = path.join(tempRoot, "home-plain");
      const withAgyHome = path.join(tempRoot, "home-agy");
      await fs.mkdir(noAgyHome, { recursive: true });
      await fs.mkdir(path.join(withAgyHome, ".gemini", "antigravity"), { recursive: true });
      assert.ok(resolveDbPath({ SAVE_TOKEN_HOME: noAgyHome }).replace(/\\/g, "/").endsWith("/.save-token/data/store.db"));
      assert.ok(resolveDbPath({ SAVE_TOKEN_HOME: withAgyHome }).replace(/\\/g, "/").endsWith("/.gemini/antigravity/plugin_data/save-token/store.db"));

      console.log("PASS Test 23: v1.3.0 TOON, CCR receipt, cross-platform hooks/transcripts, inferBranch & storage paths");
    } finally {
      await stopServer(server6.proc);
    }

    assert.equal(server2.client.stderrBuf, "", `Server 2 stderr: ${server2.client.stderrBuf}`);
    console.log("ALL 23 TESTS PASSED");
  } finally {
    await stopServer(server1.proc).catch(() => {});
    if (server2) await stopServer(server2.proc).catch(() => {});
    if (webServer) await new Promise((r) => webServer.close(r));
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
