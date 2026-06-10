import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  const runId = "202606101202-advise-cccc";
  const specPath = writeSpec(home, {
    runId, prompt: "Pick a queue library", directory: home, mode: "advise", conversation: "default",
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
