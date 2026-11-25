import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    handoff: "",
    title: "Tiep noi phien lam viec",
    model: "flash",
    tags: ["save-token", "handoff"],
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--handoff" && argv[i + 1]) out.handoff = argv[++i];
    else if (a === "--title" && argv[i + 1]) out.title = argv[++i];
    else if (a === "--model" && argv[i + 1]) out.model = argv[++i];
    else if (a === "--tags" && argv[i + 1]) {
      out.tags = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.handoff) {
    console.error("Usage: node handoff-new-chat.mjs --handoff <path.md> [--title <title>] [--model flash|pro|flash_lite] [--tags a,b] [--dry-run]");
    process.exit(1);
  }

  const handoffPath = path.resolve(opts.handoff);
  const handoffMd = (await fs.readFile(handoffPath, "utf8")).trim();

  const promptText = [
    "Tiếp nối ngữ cảnh từ phiên trước:",
    "",
    handoffMd,
    "",
    "---",
    "Lưu ý: Gọi `save_token_resume({ handoffId: \"latest\" })` hoặc `save_token_search` nếu cần tra thêm chi tiết/memory từ phiên cũ.",
  ].join("\n");

  const payload = {
    title: opts.title,
    model: opts.model,
    tags: opts.tags,
    prompt: [{ text: promptText }],
  };
  if (process.env.ANTIGRAVITY_PROJECT_ID) {
    payload.projectId = process.env.ANTIGRAVITY_PROJECT_ID;
  }

  const addr = process.env.ANTIGRAVITY_LS_ADDRESS || "localhost:5387";
  const endpoint = `http://${addr}/product.v1.ConversationService/CreateConversation`;

  if (opts.dryRun) {
    console.log(JSON.stringify({ dryRun: true, endpoint, handoffPath, payload }, null, 2));
    return;
  }

  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!csrf) {
    console.error("Missing ANTIGRAVITY_CSRF_TOKEN in environment.");
    process.exit(1);
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-antigravity-csrf-token": csrf,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  const rawText = await res.text();
  if (!res.ok) {
    console.error(`CreateConversation failed (${res.status}): ${rawText}`);
    process.exit(1);
  }

  const data = JSON.parse(rawText);
  const convId = data?.conversation?.id || "";
  console.log(
    JSON.stringify(
      {
        ok: Boolean(convId),
        conversationId: convId,
        title: opts.title,
        link: convId ? `[${opts.title}](conversation://${convId})` : null,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
