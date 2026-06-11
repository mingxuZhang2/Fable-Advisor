import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "server.js");
const FAKE = path.join(ROOT, "tests", "fake-claude.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 起一个真实的 stdio MCP server 子进程,按行收发 JSON-RPC
function startServer(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fable-srv-"));
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, FABLE_HOME: home, FABLE_CLAUDE_BIN: FAKE,
      FABLE_BASE_URL: "https://x", FABLE_AUTH_TOKEN: "sk-x",
      FABLE_RETRY_DELAYS_MS: "20,20,20", ...extraEnv },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let id = 0;
  const pending = new Map();
  const notifications = [];
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === "notifications/progress") notifications.push(msg.params);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const send = (method, params) => new Promise((res) => {
    const msgId = ++id;
    pending.set(msgId, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
  });
  return {
    proc, home, send, notifications,
    call: async (name, args, meta) => {
      const params = { name, arguments: args };
      if (meta) params._meta = meta;
      const r = await send("tools/call", params);
      return { isError: r.result?.isError ?? false, text: r.result?.content?.[0]?.text ?? "" };
    },
    init: async () => {
      await send("initialize", { protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "t", version: "0" } });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    // 兜底清场:杀掉某个 run 残留的 runner 进程组(cancel 失败也不泄漏进程)
    killRun: (runId) => {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(home, "runs", runId, "state.json")));
        if (st.status === "running" && st.pid > 0) {
          try { process.kill(-st.pid, "SIGKILL"); } catch { try { process.kill(st.pid, "SIGKILL"); } catch {} }
        }
      } catch {}
    },
  };
}

test("tools/list exposes exactly the five tools", async (t) => {
  const s = startServer();
  t.after(() => s.proc.kill());
  await s.init();
  const r = await s.send("tools/list", {});
  assert.deepEqual(r.result.tools.map((x) => x.name).sort(),
    ["consult_fable", "fable_cancel", "fable_conversations", "fable_result", "fable_status"]);
});

test("blocking consult answers, registers conversation, and resumes on second call", async (t) => {
  const s = startServer();
  t.after(() => s.proc.kill());
  await s.init();
  const dir = s.home; // 任意存在的绝对路径即可

  const first = await s.call("consult_fable", { prompt: "review this", directory: dir, mode: "review" });
  assert.equal(first.isError, false);
  assert.match(first.text, /FRESH-ANSWER/);
  assert.match(first.text, /\(new\)/);

  const list = await s.call("fable_conversations", { directory: dir });
  assert.match(list.text, /default/);
  assert.match(list.text, /\[review\]/);

  // 同名对话第二次调用:注册表里的 session_id 应作为 --resume 传给 claude
  const second = await s.call("consult_fable", { prompt: "continue", directory: dir, mode: "review" });
  assert.match(second.text, /RESUMED-ANSWER/);
  assert.match(second.text, /\(resumed\)/);
});

test("background consult: immediate run_id, status transitions to done, result fetches answer", async (t) => {
  const s = startServer();
  t.after(() => s.proc.kill());
  await s.init();

  const r = await s.call("consult_fable",
    { prompt: "audit it", directory: s.home, mode: "audit", background: true });
  const runId = r.text.match(/run_id: (\S+)/)?.[1];
  assert.ok(runId, `background reply should contain run_id, got: ${r.text}`);
  t.after(() => s.killRun(runId));
  assert.match(r.text, /tail -f/);

  // 立即返回的证据:此刻 run 仍在 running(或刚好已 done),status 工具能看到它
  const firstStatus = await s.call("fable_status", { run_id: runId });
  assert.match(firstStatus.text, /status: (running|done)/);

  let done = false;
  for (let i = 0; i < 50 && !done; i++) {
    await sleep(100);
    const st = await s.call("fable_status", { run_id: runId });
    done = /status: done/.test(st.text);
  }
  assert.ok(done, "background run should finish");

  const res = await s.call("fable_result", { run_id: runId });
  assert.match(res.text, /FRESH-ANSWER/);
  assert.match(res.text, /run_id/);
});

test("cancel kills a hung background run", async (t) => {
  const s = startServer({ FAKE_MODE: "hang", FABLE_STALL_MINUTES: "10" });
  t.after(() => s.proc.kill());
  await s.init();

  const r = await s.call("consult_fable",
    { prompt: "hang it", directory: s.home, background: true });
  const runId = r.text.match(/run_id: (\S+)/)?.[1];
  assert.ok(runId);
  t.after(() => s.killRun(runId));

  await sleep(300); // 等 runner 落盘真实 pid
  await s.call("fable_cancel", { run_id: runId });

  let cancelled = false;
  for (let i = 0; i < 30 && !cancelled; i++) {
    await sleep(100);
    const st = await s.call("fable_status", { run_id: runId });
    cancelled = /status: cancelled/.test(st.text);
  }
  assert.ok(cancelled, "run should reach cancelled state");
});

test("blocking consult streams progress notifications when client passes a progressToken", async (t) => {
  const s = startServer();
  t.after(() => s.proc.kill());
  await s.init();

  const r = await s.call("consult_fable",
    { prompt: "review", directory: s.home }, { progressToken: "tok-1" });
  assert.equal(r.isError, false);
  assert.ok(s.notifications.length >= 1, "should have received progress notifications");
  for (const n of s.notifications) {
    assert.equal(n.progressToken, "tok-1");
    assert.match(n.message, /step \d+ · .+ · \d+s/);
  }
  // 不带 token 的调用不应产生新通知
  const before = s.notifications.length;
  await s.call("consult_fable", { prompt: "again", directory: s.home, fresh: true });
  assert.equal(s.notifications.length, before);
});

test("consult rejects a non-existent or relative directory", async (t) => {
  const s = startServer();
  t.after(() => s.proc.kill());
  await s.init();
  const rel = await s.call("consult_fable", { prompt: "x", directory: "relative/path" });
  assert.equal(rel.isError, true);
  const gone = await s.call("consult_fable", { prompt: "x", directory: "/definitely/not/here-xyz" });
  assert.equal(gone.isError, true);
});

test("status and result report gracefully when there are no runs", async (t) => {
  const s = startServer();
  t.after(() => s.proc.kill());
  await s.init();
  const st = await s.call("fable_status", {});
  assert.match(st.text, /No runs yet\./);
  const res = await s.call("fable_result", {});
  assert.match(res.text, /No runs yet\./);
  const convs = await s.call("fable_conversations", {});
  assert.match(convs.text, /No conversations yet\./);
  const del = await s.call("fable_conversations", { action: "delete" });
  assert.equal(del.isError, true); // delete 必须带 directory+name
});
