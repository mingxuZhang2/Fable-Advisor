#!/usr/bin/env node
// 模拟 claude -p --output-format stream-json。FAKE_MODE 控制行为:
//   ok(默认)— 两轮工具+文本后成功;resume 时 result 带 resumed 标记文本
//   429twice — 前两次启动即失败(stderr 429,退出码 1),第三次走 ok(计数文件在 FAKE_STATE)
//   hang — 输出 init 后永久沉默(测 stall watchdog)
import fs from "node:fs";

const mode = process.env.FAKE_MODE || "ok";
const resumed = process.argv.includes("--resume");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === "429twice") {
  const f = process.env.FAKE_STATE;
  const n = Number(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : 0);
  fs.writeFileSync(f, String(n + 1));
  if (n < 2) { console.error("API error: 429 rate limit"); process.exit(1); }
}

out({ type: "system", subtype: "init", session_id: "fake-session-1" });
if (mode === "hang") { setInterval(() => {}, 1e6); } else {
  await sleep(30);
  out({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Read", input: { file_path: "src/a.py" } }] } });
  await sleep(30);
  out({ type: "assistant", message: { content: [
    { type: "text", text: resumed ? "continuing our chat" : "fresh analysis" }] } });
  await sleep(30);
  out({ type: "result", subtype: "success", is_error: false,
    result: resumed ? "RESUMED-ANSWER" : "FRESH-ANSWER",
    session_id: "fake-session-2", total_cost_usd: 0.01,
    usage: { output_tokens: 42 }, num_turns: 2 });
}
