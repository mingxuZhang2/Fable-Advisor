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
const STALL_MIN = Number(process.env.FABLE_STALL_MINUTES) || 10; // 0/NaN/空串 → 默认 10
const STALL_MS = STALL_MIN * 60_000;
// 心跳:上游静默(如 429 内部重试)期间也定期刷新 state.updated,
// 让 server 的 progress 通知持续流出——否则 MCP 客户端会按超时掐断阻塞调用
const HEARTBEAT_MS = Number(process.env.FABLE_HEARTBEAT_MS) || 10_000;
const RETRY_DELAYS = (process.env.FABLE_RETRY_DELAYS_MS || "5000,15000,30000")
  .split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const RETRYABLE = /429|rate.?limit|overloaded|service unavailable|529|ECONNRESET|ETIMEDOUT/i;
const SESSION_GONE = /no conversation found|session.*not found/i;
const TOOL_ACTION = /^(Read|Grep|Glob|WebFetch|WebSearch)\b/;

const dir = runDir(spec.runId);
const statePath = path.join(dir, "state.json");
const livePath = path.join(dir, "live.md");
const started = Date.now();

let state = {
  status: "running", pid: process.pid, pgid: process.pid, turn: 0, action: "starting",
  // pgid === pid:runner 以 detached 方式被 server 启动,自己就是进程组组长(server 用 kill(-pid) 取消)
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

// 启动即校验必需环境变量:缺了就快速失败,留下明确的 stderr + failed 状态
const missingEnv = ["FABLE_BASE_URL", "FABLE_AUTH_TOKEN"].filter((k) => !process.env[k]);
if (missingEnv.length) {
  const msg = `missing required env: ${missingEnv.join(", ")}`;
  console.error(`fable-advisor runner: ${msg}`);
  setState({ status: "failed", action: msg });
  process.exit(1);
}

// 任何未捕获异常:落盘 failed 状态再退出,不留 "running" 僵尸状态
process.on("uncaughtException", (err) => {
  const msg = `internal error: ${err?.message ?? err}`;
  console.error(`fable-advisor runner: ${msg}`);
  try { setState({ status: "failed", action: msg.slice(0, 200) }); } catch {}
  process.exit(1);
});

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

// 杀整个子进程组(claude 自己可能再 spawn 后代);失败时回退到只杀 child
function killChildGroup() {
  if (!child) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch {} }
}

process.on("SIGTERM", () => { // 取消路径(server kill(-runnerPid) 触发):杀子进程组、同步落盘状态,再退出
  killChildGroup();
  setState({ status: "cancelled", action: "cancelled by user" });
  try { live(`\n## CANCELLED\n`); } catch {}
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
      "--include-partial-messages", // 流式增量也喂 watchdog:长单消息生成期间保持活性信号
    ];
    if (resumeId) args.push("--resume", resumeId);

    // stdin=ignore:真实 claude -p 会阻塞等待永不关闭的 stdin 管道
    // detached:claude 自成进程组,便于连同其后代一起 SIGKILL
    child = spawn(CLAUDE_BIN, args, {
      cwd: spec.directory, env: childEnv,
      stdio: ["ignore", "pipe", "pipe"], detached: true,
    });

    let terminal = null;
    let stderrBuf = "";
    let stalled = false;
    let watchdog = null;
    let settled = false;
    const heartbeat = setInterval(() => setState({}), HEARTBEAT_MS); // 空 patch 只刷新 updated
    const settle = (r) => { // 幂等:watchdog 先 resolve 后,close/exit 再触发也无害
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearInterval(heartbeat);
      resolve(r);
    };
    const resetWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        // 直接在这里 resolve:若 claude 的后代继承了 stdout,close 可能永远不来
        stalled = true;
        killChildGroup();
        settle({ stalled: true });
      }, STALL_MS);
    };
    resetWatchdog();

    const STDERR_CAP = 8192; // 只保留末尾 ~8KB,防失控输出撑爆内存
    child.stderr.on("data", (d) => { stderrBuf = (stderrBuf + d).slice(-STDERR_CAP); });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      resetWatchdog(); // 先喂狗再解析:任何原始输出行都算活性信号
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
      child = null;
      settle({ reason: err.message });
    });
    child.on("close", (code) => {
      child = null;
      // 先看终态事件再看 stalled:已完成但迟迟不退出的 run 不应误报为 stalled
      if (terminal && !terminal.is_error) return settle({ ok: true, event: terminal });
      if (stalled) return settle({ stalled: true });
      settle({ reason: terminal?.result || stderrBuf.trim() || `claude exited with code ${code}` });
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
  try { // 注册表更新失败不应让整个 run 失败:result.json 已写完,结果是完整的
    const prev = getConversation(spec.directory, spec.conversation);
    setConversation(spec.directory, spec.conversation, {
      session_id: event.session_id,
      mode: spec.mode,
      turns: spec.fresh ? 1 : (prev?.turns ?? 0) + 1, // fresh 重开:轮数从 1 重计
      last_used: new Date().toISOString(),
      summary: spec.prompt.slice(0, 120),
    });
  } catch (err) {
    live(`> [${hms()}] warning: failed to update conversations registry: ${err?.message ?? err}\n`);
  }
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
