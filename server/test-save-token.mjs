import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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

function startServer(dbPath) {
  const proc = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NODE_OPTIONS: "--title=should-be-stripped",
      SAVE_TOKEN_DB_PATH: dbPath,
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

    assert.equal(server2.client.stderrBuf, "", `Server 2 stderr: ${server2.client.stderrBuf}`);
    console.log("ALL 14 TESTS PASSED");
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
