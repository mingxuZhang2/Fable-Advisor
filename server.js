#!/usr/bin/env node
/**
 * fable-advisor v2 — MCP stdio server.
 *
 * 薄壳:校验参数 → 写 run 目录 + spec.json → spawn detached runner.js。
 * 阻塞模式轮询 state.json 并转发 MCP progress notification;
 * 后台模式立即返回 run_id。所有状态都在磁盘(~/.fable-advisor),
 * server 随时可以死掉重启,不影响在跑的任务。
 *
 * Required env (set via `claude mcp add -e ...`):
 *   FABLE_BASE_URL    e.g. https://your-relay.example.com
 *   FABLE_AUTH_TOKEN  the relay's sk-... token
 * Optional env(由 runner 消费):
 *   FABLE_MODEL / FABLE_CLAUDE_BIN / FABLE_HOME /
 *   FABLE_STALL_MINUTES / FABLE_RETRY_DELAYS_MS
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./lib/store.js";
import { MODE_NAMES, DEFAULT_MODE } from "./lib/modes.js";

if (!process.env.FABLE_BASE_URL || !process.env.FABLE_AUTH_TOKEN) {
  console.error("fable-advisor: FABLE_BASE_URL and FABLE_AUTH_TOKEN must be set");
  process.exit(1);
}

const RUNNER = path.join(import.meta.dirname, "runner.js");
const POLL_MS = 500;
const ORPHAN_MS = 60_000;
const BLOCKING_MAX_MS = Number(process.env.FABLE_BLOCKING_MAX_MS) || 1_770_000; // 默认 29.5min,留 30s 余量给 MCP 客户端 30min 超时

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ isError: true, content: [{ type: "text", text }] });

const pidAlive = (pid) => {
  // pid 0/负数对 process.kill 是"整个进程组",绝不能当普通 pid 探测
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const statePath = (runId) => path.join(store.runDir(runId), "state.json");
const livePath = (runId) => path.join(store.runDir(runId), "live.md");

function readState(runId) {
  const st = store.readJson(statePath(runId));
  if (!st) return null;
  // 孤儿检测:声称在跑但超过 60s 没更新且进程已死 → 改判 failed
  if (st.status === "running" && Date.now() - Date.parse(st.updated) > ORPHAN_MS && !pidAlive(st.pid)) {
    const dead = { ...st, status: "failed", action: "runner died unexpectedly",
      updated: new Date().toISOString() };
    store.writeJson(statePath(runId), dead);
    return dead;
  }
  return st;
}

const resolveRunId = (runId) => runId || store.latestRunId();

// 在跑:距开始的耗时;终态:总耗时(用 updated 封顶,避免昨天的 run 显示越长越大)
const elapsedSec = (st) => {
  const end = st.status === "running" ? Date.now() : Date.parse(st.updated);
  return Math.round((end - Date.parse(st.started)) / 1000);
};

const fmtTokens = (n = 0) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`);

function fmtResult(r, runId, turns) {
  const stats = [
    `mode: ${r.mode}`,
    `conversation: ${r.conversation} (${r.resumed ? "resumed" : "new"})`,
    `turns: ${turns}`,
    `output: ${fmtTokens(r.usage?.output_tokens)}`,
    `cost: $${(r.cost_usd ?? 0).toFixed(3)}`,
    `time: ${Math.round((r.duration_ms ?? 0) / 1000)}s`,
    `run_id: ${runId}`,
  ].join(" | ");
  const header = `[${stats}]`;
  const report = r.report_path ? `\nreport: ${r.report_path}` : "";
  return `${header}${report}\n\n${r.text ?? "(result.json unreadable)"}`;
}

function statusText(runId) {
  const st = readState(runId);
  if (!st) return `No run found${runId ? ` for ${runId}` : ""}.`;
  let tail = "";
  try { tail = fs.readFileSync(livePath(runId), "utf8").trimEnd().split("\n").slice(-6).join("\n"); } catch {}
  return `run_id: ${runId}
status: ${st.status}
mode: ${st.mode} · conversation: ${st.conversation}
steps so far: ${st.turn} · ${fmtTokens(st.tokens)} · elapsed: ${elapsedSec(st)}s
current: ${st.action}
live transcript: tail -f ${livePath(runId)}

recent output:
${tail}`;
}

function newRunId(mode) {
  // 约束:store.listRuns() 只认 /^\d{12}-/ 前缀,且靠字典序当时间序。
  // 12 位放不下 "YYYYMMDDHHmm" 之外再加秒,故用 2 位年:YYMMDDHHmmss(UTC)。
  // 秒级粒度;同一秒内多个 run 退化为按 mode/随机段排序(latestRunId 只是缺省兜底,可接受)。
  const ts = new Date().toISOString().slice(2, 19).replace(/[-:T]/g, "");
  return `${ts}-${mode}-${randomBytes(2).toString("hex")}`;
}

function launchRun(args) {
  const runId = newRunId(args.mode);
  const dir = store.runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const conv = args.fresh ? null : store.getConversation(args.directory, args.conversation);
  const spec = {
    runId, prompt: args.prompt, directory: args.directory, mode: args.mode,
    conversation: args.conversation, fresh: args.fresh, files: args.files ?? [],
    resumeSessionId: conv?.session_id ?? null,
  };
  const specPath = path.join(dir, "spec.json");
  store.writeJson(specPath, spec);
  const now = new Date().toISOString();
  store.writeJson(statePath(runId), {
    status: "running", pid: 0, turn: 0, action: "launching runner",
    started: now, updated: now,
    runId, conversation: args.conversation, directory: args.directory, mode: args.mode,
  });
  // detached + 自成进程组:server/主会话死了它照跑;cancel 用 kill(-pid) 收割全组
  const child = spawn(process.execPath, [RUNNER, specPath],
    { detached: true, stdio: "ignore", env: process.env });
  // 异步 spawn 失败(EAGAIN/ENOMEM)会 emit error;没监听会带崩整个 server
  child.on("error", (err) => {
    store.writeJson(statePath(runId), {
      status: "failed", pid: 0, turn: 0, action: `failed to spawn runner: ${err.message}`,
      started: now, updated: new Date().toISOString(),
      runId, conversation: args.conversation, directory: args.directory, mode: args.mode,
    });
  });
  child.unref();
  return { runId, resumed: Boolean(spec.resumeSessionId) };
}

const server = new McpServer({ name: "fable-advisor", version: "2.0.0" });

server.registerTool("consult_fable", {
  title: "Consult Fable",
  description:
    "Consult Fable (a strong reviewer model on a separate endpoint) for code review, project review, " +
    "audit, debate/discussion, or technical advice. Fable explores the given directory itself " +
    "(read-only: Read/Grep/Glob + web) — the prompt only needs to say what to look at and why. " +
    "Conversations are persistent: pass the same `conversation` name to continue a thread with full memory, " +
    "a new name (or fresh=true) to start over. Slow (typically minutes). For big jobs set background=true " +
    "and poll fable_status / fetch fable_result instead of waiting.",
  inputSchema: {
    prompt: z.string().describe(
      "What to review/audit/discuss/ask. Self-contained; include context Fable can't read from disk."),
    directory: z.string().describe("Absolute path of the project directory Fable may read."),
    mode: z.enum(MODE_NAMES).default(DEFAULT_MODE).describe(
      "review=pure code review, implementation correctness (Critical/Important/Minor findings with file:line); " +
      "audit=adversarial security/quality sweep; " +
      "discuss=default — debate partner / second opinion / architecture & design discussion, takes positions; " +
      "research=interpret experimental results vs the author's goal, critique the experimental " +
      "setup, rank next steps by information gain. All modes can fan out read-only subagents " +
      "for large scopes (slower and pricier — prefer background=true for big jobs)"),
    conversation: z.string().default("default").describe(
      "Named thread. Same name = Fable continues with memory of prior turns."),
    fresh: z.boolean().default(false).describe("Discard this conversation's history and start anew."),
    files: z.array(z.string()).optional().describe("Files/subdirs (relative to directory) to focus on."),
    background: z.boolean().default(false).describe(
      "true: return run_id immediately; poll fable_status, fetch fable_result when done."),
  },
}, async (args, extra) => {
  if (!path.isAbsolute(args.directory) || !fs.existsSync(args.directory)) {
    return fail(`directory must be an existing absolute path, got: ${args.directory}`);
  }
  const { runId, resumed } = launchRun(args);

  if (args.background) {
    return ok(`Started background run.
run_id: ${runId}
conversation: ${args.conversation} (${resumed ? "resumed" : "new"})
Watch live: tail -f ${livePath(runId)}
Poll with fable_status, fetch the answer with fable_result.`);
  }

  // 阻塞模式:轮询状态文件,状态变化转成 progress notification(客户端给了 token 才发)
  // 超过 BLOCKING_MAX_MS 自动降级为后台模式,避免 MCP 客户端超时
  const progressToken = extra._meta?.progressToken;
  const pollStart = Date.now();
  let lastUpdated = "";
  let progress = 0;
  for (;;) {
    await sleep(POLL_MS);
    if (extra.signal?.aborted) {
      return ok(`Wait aborted; the run continues in the background.
run_id: ${runId}
Use fable_status / fable_result, or fable_cancel to stop it.`);
    }
    const st = readState(runId);
    if (!st) return fail(`Run ${runId}: state.json vanished — see ${store.runDir(runId)}`);
    if (st.updated !== lastUpdated && progressToken !== undefined) {
      lastUpdated = st.updated;
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: ++progress,
          message: `step ${st.turn} · ${st.action} · ${fmtTokens(st.tokens)} · ${elapsedSec(st)}s` },
      }).catch(() => {});
    }
    if (st.status === "running") {
      if (Date.now() - pollStart > BLOCKING_MAX_MS) {
        return ok(`Still running (${elapsedSec(st)}s, step ${st.turn}, ${fmtTokens(st.tokens)}) — auto-switched to background to avoid timeout.
run_id: ${runId}
current: ${st.action}
Poll with fable_status, fetch the answer with fable_result when done.
Watch live: tail -f ${livePath(runId)}`);
      }
      continue;
    }
    if (st.status !== "done") {
      return fail(`Run ${st.status}: ${st.action}\nPartial transcript: ${livePath(runId)}`);
    }
    const r = store.readJson(path.join(store.runDir(runId), "result.json"), {});
    const turns = store.getConversation(args.directory, args.conversation)?.turns ?? "?";
    return ok(fmtResult(r, runId, turns));
  }
});

server.registerTool("fable_status", {
  title: "Fable run status",
  description: "Check progress of a Fable run: status, current step, elapsed time, recent output. " +
    "Defaults to the latest run.",
  inputSchema: { run_id: z.string().optional().describe("Run to inspect; defaults to the latest.") },
}, async ({ run_id }) => {
  const id = resolveRunId(run_id);
  return id ? ok(statusText(id)) : ok("No runs yet.");
});

server.registerTool("fable_result", {
  title: "Fable run result",
  description: "Fetch the final answer of a (background) Fable run. Defaults to the latest run.",
  inputSchema: { run_id: z.string().optional().describe("Run to fetch; defaults to the latest.") },
}, async ({ run_id }) => {
  const id = resolveRunId(run_id);
  if (!id) return ok("No runs yet.");
  const r = store.readJson(path.join(store.runDir(id), "result.json"));
  if (!r) return ok(`Not finished.\n\n${statusText(id)}`);
  const st = store.readJson(statePath(id));
  const turns = st ? store.getConversation(st.directory, st.conversation)?.turns ?? "?" : "?";
  return ok(fmtResult(r, id, turns));
});

server.registerTool("fable_conversations", {
  title: "Fable conversations",
  description: "List or delete named Fable conversation threads (per project directory).",
  inputSchema: {
    directory: z.string().optional().describe("Filter by project directory (list) / scope (delete)."),
    action: z.enum(["list", "delete"]).default("list"),
    name: z.string().optional().describe("Conversation name (required for delete)."),
  },
}, async ({ directory, action, name }) => {
  if (action === "delete") {
    if (!directory || !name) return fail("delete requires both directory and name");
    store.deleteConversation(directory, name);
    return ok(`Deleted conversation "${name}" for ${directory}.`);
  }
  const list = store.listConversations(directory ?? null);
  if (!list.length) return ok("No conversations yet.");
  return ok(list.map((c) =>
    `- ${c.name} [${c.mode}] · ${c.turns} turns · last: ${c.last_used}\n  dir: ${c.directory}\n  about: ${c.summary}`
  ).join("\n"));
});

server.registerTool("fable_cancel", {
  title: "Cancel Fable run",
  description: "Cancel a running Fable consultation (kills its whole process group; " +
    "live.md keeps the partial transcript). Defaults to the latest run.",
  inputSchema: { run_id: z.string().optional().describe("Run to cancel; defaults to the latest.") },
}, async ({ run_id }) => {
  const id = resolveRunId(run_id);
  const st = id ? readState(id) : null;
  if (!st) return ok("No run found.");
  if (st.status !== "running") return ok(`Run ${id} already ${st.status}.`);
  if (!pidAlive(st.pid)) {
    // pid 还是占位 0(刚启动)或进程已死:没有可杀对象,交给孤儿检测/稍后重试
    return ok(`Run ${id} has no live runner process yet (pid ${st.pid}); retry shortly or check fable_status.`);
  }
  // runner 是 detached 进程组组长:优先杀全组(连同 claude 及其后代),失败回退单杀
  try { process.kill(-st.pid, "SIGTERM"); }
  catch { try { process.kill(st.pid, "SIGTERM"); } catch {} }
  await sleep(300); // 给 runner 的 SIGTERM handler 时间落盘 cancelled 状态
  return ok(statusText(id));
});

await server.connect(new StdioServerTransport());
