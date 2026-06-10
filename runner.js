#!/usr/bin/env node
// 可分离执行器:node runner.js <specPath>
// 跑一次 Fable 咨询(spawn headless claude),全部状态落盘 run 目录,
// 父进程(MCP server)死掉不影响本进程;结束时回写 conversations 注册表。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { runDir, readJson, writeJson, getConversation, setConversation } from "./lib/store.js";
import { systemPromptFor } from "./lib/modes.js";
import { describeEvent } from "./lib/events.js";

const spec = readJson(process.argv[2]);
if (!spec?.runId) {
  console.error("usage: node runner.js <specPath> (spec JSON must contain runId)");
  process.exit(2);
}

const MODEL = process.env.FABLE_MODEL || "claude-fable-5[1m]";
const CLAUDE_BIN = process.env.FABLE_CLAUDE_BIN || "claude";
const STALL_MIN = Number(process.env.FABLE_STALL_MINUTES || 10);
const STALL_MS = STALL_MIN * 60_000;
const RETRY_DELAYS = (process.env.FABLE_RETRY_DELAYS_MS || "5000,15000,30000")
  .split(",").map(Number);
const RETRYABLE = /429|rate.?limit|overloaded|service unavailable|529|ECONNRESET|ETIMEDOUT/i;
const SESSION_GONE = /no conversation found|session.*not found/i;
const TOOL_ACTION = /^(Read|Grep|Glob|WebFetch|WebSearch)\b/;

const dir = runDir(spec.runId);
const statePath = path.join(dir, "state.json");
const livePath = path.join(dir, "live.md");
const started = Date.now();

let state = {
  status: "running", pid: process.pid, turn: 0, action: "starting",
  started: new Date(started).toISOString(), updated: new Date(started).toISOString(),
  runId: spec.runId, conversation: spec.conversation, directory: spec.directory, mode: spec.mode,
};
writeJson(statePath, state);

function setState(patch) {
  state = { ...state, ...patch, updated: new Date().toISOString() };
  writeJson(statePath, state);
}
const live = (text) => fs.appendFileSync(livePath, text);
const hms = () => new Date().toTimeString().slice(0, 8);

live(`# Fable run ${spec.runId}

- mode: ${spec.mode}
- conversation: ${spec.conversation}
- directory: ${spec.directory}
- started: ${state.started}

## Prompt

${spec.prompt}

## Transcript

`);

const promptText = spec.files?.length
  ? `${spec.prompt}\n\nFocus on these files first:\n${spec.files.map((f) => `- ${f}`).join("\n")}`
  : spec.prompt;

const childEnv = {
  ...process.env,
  ANTHROPIC_BASE_URL: process.env.FABLE_BASE_URL,
  ANTHROPIC_AUTH_TOKEN: process.env.FABLE_AUTH_TOKEN,
  ANTHROPIC_MODEL: MODEL,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
delete childEnv.ANTHROPIC_API_KEY; // 与 AUTH_TOKEN 同时存在会被 API 拒绝

let child = null;

process.on("SIGTERM", () => { // 取消路径:先杀子进程、落盘状态,再退出
  try { child?.kill("SIGKILL"); } catch {}
  setState({ status: "cancelled", action: "cancelled by user" });
  process.exit(0);
});

// 单次尝试:resolve {ok,event} | {stalled:true} | {reason}
function runAttempt(resumeId) {
  return new Promise((resolve) => {
    const args = [
      "-p", promptText, "--model", MODEL, "--setting-sources", "",
      "--allowedTools", "Read", "Grep", "Glob", "WebFetch", "WebSearch",
      "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit",
      "--append-system-prompt", systemPromptFor(spec.mode),
      "--output-format", "stream-json", "--verbose",
    ];
    if (resumeId) args.push("--resume", resumeId);

    child = spawn(CLAUDE_BIN, args, { cwd: spec.directory, env: childEnv });

    let terminal = null;
    let stderrBuf = "";
    let stalled = false;
    let watchdog = null;
    const resetWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { stalled = true; child?.kill("SIGKILL"); }, STALL_MS);
    };
    resetWatchdog();

    child.stderr.on("data", (d) => { stderrBuf += d; });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      resetWatchdog();
      let evt;
      try { evt = JSON.parse(line); } catch { return; }
      for (const item of describeEvent(evt)) {
        if (item.action) {
          setState(TOOL_ACTION.test(item.action)
            ? { turn: state.turn + 1, action: item.action }
            : { action: item.action });
          live(`> [${hms()}] ${item.action}\n`);
        } else if (item.text) {
          setState({ action: "writing analysis" });
          live(`${item.text}\n`);
        } else if (item.done) {
          terminal = item.event;
        }
      }
    });
    child.on("error", (err) => { // spawn 自身失败(如 ENOENT),不会再有 close
      clearTimeout(watchdog);
      child = null;
      resolve({ reason: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      child = null;
      if (stalled) return resolve({ stalled: true });
      if (terminal && !terminal.is_error) return resolve({ ok: true, event: terminal });
      resolve({ reason: terminal?.result || stderrBuf.trim() || `claude exited with code ${code}` });
    });
  });
}

function fail(reason) {
  setState({ status: "failed", action: reason.slice(0, 200) });
  live(`\n## FAILED\n\n${reason}\n`);
  process.exit(1);
}

function succeed(event, resumed) {
  writeJson(path.join(dir, "result.json"), {
    text: event.result ?? "",
    session_id: event.session_id,
    cost_usd: event.total_cost_usd,
    usage: event.usage,
    num_turns: event.num_turns,
    duration_ms: event.duration_ms ?? Date.now() - started,
    conversation: spec.conversation,
    mode: spec.mode,
    resumed,
  });
  const prev = getConversation(spec.directory, spec.conversation);
  setConversation(spec.directory, spec.conversation, {
    session_id: event.session_id,
    mode: spec.mode,
    turns: (prev?.turns ?? 0) + 1,
    last_used: new Date().toISOString(),
    summary: spec.prompt.slice(0, 120),
  });
  setState({ status: "done", action: "complete" });
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let resumeId = spec.resumeSessionId || null;
for (let attempt = 0; ; ) {
  const r = await runAttempt(resumeId);
  if (r.ok) succeed(r.event, Boolean(resumeId));
  if (r.stalled) fail(`stalled: no events for ${STALL_MIN} min`);
  if (resumeId && SESSION_GONE.test(r.reason)) {
    // 中转清理了 session:降级新开对话,立即重试,不消耗重试名额
    live(`> [${hms()}] session expired upstream, starting fresh conversation\n`);
    resumeId = null;
    continue;
  }
  if (attempt < RETRY_DELAYS.length && RETRYABLE.test(r.reason)) {
    const delay = RETRY_DELAYS[attempt];
    attempt += 1;
    const note = `rate limited, retry ${attempt}/${RETRY_DELAYS.length} in ${delay}ms`;
    setState({ action: note });
    live(`> [${hms()}] ${note} — ${r.reason.slice(0, 120)}\n`);
    await sleep(delay);
    continue;
  }
  fail(r.reason);
}
