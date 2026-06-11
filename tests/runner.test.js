import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, "..");
const RUNNER = path.join(ROOT, "runner.js");
const FAKE = path.join(ROOT, "tests", "fake-claude.js");

function setup(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fable-run-"));
  return { home, env: { ...process.env, FABLE_HOME: home, FABLE_CLAUDE_BIN: FAKE,
    FABLE_BASE_URL: "https://x", FABLE_AUTH_TOKEN: "sk-x",
    FABLE_RETRY_DELAYS_MS: "20,20,20", FABLE_STALL_MINUTES: "1", ...extraEnv } };
}

function writeSpec(home, spec) {
  const p = path.join(home, "spec.json");
  fs.writeFileSync(p, JSON.stringify(spec));
  return p;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const runFiles = (home, runId) => {
  const dir = path.join(home, "runs", runId);
  return {
    state: readJson(path.join(dir, "state.json")),
    result: () => readJson(path.join(dir, "result.json")),
    live: () => fs.readFileSync(path.join(dir, "live.md"), "utf8"),
  };
};
// 轮询直到 fn() 返回真值(文件未就绪抛错按"未就绪"处理),代替易 flake 的固定 sleep
async function waitFor(fn, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = fn();
      if (v) return v;
    } catch {}
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("happy path: done state, result.json, live transcript, conversations registry", async () => {
  const { home, env } = setup();
  const runId = "202606101200-review-aaaa";
  const specPath = writeSpec(home, {
    runId, prompt: "Review the trainer", directory: home, mode: "review",
    conversation: "default", files: ["src/a.py"],
  });
  await run(process.execPath, [RUNNER, specPath], { env });

  const { state, result, live } = runFiles(home, runId);
  assert.equal(state.status, "done");
  assert.equal(state.action, "complete");
  assert.ok(state.turn >= 1); // 至少计入了 Read 工具一轮
  assert.equal(state.tokens, 42); // 两条 assistant 消息各 21 tok,result 终态确认 42
  assert.equal(state.runId, runId);

  const res = result();
  assert.equal(res.text, "FRESH-ANSWER");
  assert.equal(res.session_id, "fake-session-2");
  assert.equal(res.resumed, false);
  assert.equal(res.conversation, "default");
  assert.equal(res.mode, "review");

  const transcript = live();
  assert.match(transcript, /Read src\/a\.py/);
  assert.match(transcript, /fresh analysis/);
  assert.match(transcript, /Review the trainer/); // header 含 prompt

  const convs = readJson(path.join(home, "conversations.json"));
  assert.equal(convs[home].default.session_id, "fake-session-2");
  assert.equal(convs[home].default.turns, 1);
});

test("resume: passes --resume, result marks resumed", async () => {
  const { home, env } = setup();
  const runId = "202606101201-discuss-bbbb";
  const specPath = writeSpec(home, {
    runId, prompt: "Continue our debate", directory: home, mode: "discuss",
    conversation: "arch", resumeSessionId: "fake-session-2",
  });
  await run(process.execPath, [RUNNER, specPath], { env });

  const { state, result } = runFiles(home, runId);
  assert.equal(state.status, "done");
  const res = result();
  assert.equal(res.text, "RESUMED-ANSWER");
  assert.equal(res.resumed, true);
});

test("429 twice: retries then succeeds, live.md mentions retry", async () => {
  const { home, env } = setup({
    FAKE_MODE: "429twice", FAKE_STATE: path.join(os.tmpdir(), `fable-429-${Date.now()}-${Math.random()}`),
  });
  const runId = "202606101202-discuss-cccc";
  const specPath = writeSpec(home, {
    runId, prompt: "Pick a queue library", directory: home, mode: "discuss", conversation: "default",
  });
  await run(process.execPath, [RUNNER, specPath], { env });

  const { state, result, live } = runFiles(home, runId);
  assert.equal(state.status, "done");
  assert.equal(result().text, "FRESH-ANSWER");
  assert.match(live(), /retry/i);
});

test("stall watchdog: hung child killed, state failed with stall reason, exit nonzero", async () => {
  const { home, env } = setup({ FAKE_MODE: "hang", FABLE_STALL_MINUTES: "0.005" }); // ≈300ms
  const runId = "202606101203-audit-dddd";
  const specPath = writeSpec(home, {
    runId, prompt: "Audit everything", directory: home, mode: "audit", conversation: "default",
  });
  await assert.rejects(
    run(process.execPath, [RUNNER, specPath], { env }),
    (err) => err.code !== 0,
  );

  const { state } = runFiles(home, runId);
  assert.equal(state.status, "failed");
  assert.match(state.action, /stall/i);
});

test("watchdog resets on each event: slow stream (gaps < total < stall window) still completes", async () => {
  // 事件间隔 120ms,stall 窗口 ≈420ms,总时长 ≈840ms:
  // 若 watchdog 是硬超时会失败;只有"每个事件都重置计时器"才能跑完
  const { home, env } = setup({ FAKE_MODE: "slow", FABLE_STALL_MINUTES: "0.007" });
  const runId = "202606101204-review-eeee";
  const specPath = writeSpec(home, {
    runId, prompt: "Slow but alive", directory: home, mode: "review", conversation: "default",
  });
  await run(process.execPath, [RUNNER, specPath], { env });

  const { state, result } = runFiles(home, runId);
  assert.equal(state.status, "done");
  assert.equal(result().text, "FRESH-ANSWER");
});

test("session gone upstream: downgrades to fresh conversation and succeeds", async () => {
  const { home, env } = setup({ FAKE_MODE: "session-gone" });
  const runId = "202606101205-discuss-ffff";
  const specPath = writeSpec(home, {
    runId, prompt: "Continue please", directory: home, mode: "discuss",
    conversation: "arch", resumeSessionId: "fake-session-2",
  });
  await run(process.execPath, [RUNNER, specPath], { env });

  const { state, result, live } = runFiles(home, runId);
  assert.equal(state.status, "done");
  const res = result();
  assert.equal(res.text, "FRESH-ANSWER");
  assert.equal(res.resumed, false);
  assert.match(live(), /session expired upstream/);
});

test("cancellation: SIGTERM → cancelled state, ## CANCELLED marker, exit 0", async () => {
  const { home, env } = setup({ FAKE_MODE: "hang", FABLE_STALL_MINUTES: "1" }); // stall 窗口足够大,不会先触发
  const runId = "202606101206-audit-gggg";
  const specPath = writeSpec(home, {
    runId, prompt: "Audit everything", directory: home, mode: "audit", conversation: "default",
  });
  const child = spawn(process.execPath, [RUNNER, specPath], { env, stdio: "ignore" });
  // 轮询而非固定 sleep:高负载下 runner 启动可能远超 200ms
  await waitFor(() => { runFiles(home, runId).state; return true; });
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);

  const { state, live } = runFiles(home, runId);
  assert.equal(state.status, "cancelled");
  assert.match(live(), /## CANCELLED/);
});

test("heartbeat: state.updated keeps refreshing while upstream is silent", async () => {
  const { home, env } = setup({
    FAKE_MODE: "hang", FABLE_STALL_MINUTES: "1", FABLE_HEARTBEAT_MS: "40",
  });
  const runId = "202606101207-review-hhhh";
  const specPath = writeSpec(home, {
    runId, prompt: "Slow upstream", directory: home, mode: "review", conversation: "default",
  });
  const child = spawn(process.execPath, [RUNNER, specPath], { env, stdio: "ignore" });
  try {
    const first = await waitFor(() => runFiles(home, runId).state.updated);
    // 静默期:fake 在 hang,只有心跳在动——等到 updated 变化为止
    await waitFor(() => runFiles(home, runId).state.updated !== first);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("close", resolve));
  }
});
