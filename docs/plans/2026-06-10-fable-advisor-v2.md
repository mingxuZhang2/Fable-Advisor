# fable-advisor v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 v1 单工具无状态的 fable-advisor 升级为:5 工具(consult/status/result/conversations/cancel)、5 模式预设、文件状态机支撑的后台运行、MCP progress 流式进度、命名对话持久续聊。

**Architecture:** MCP server(`server.js`)只做薄壳:校验参数、写 run 目录、spawn detached 的 `runner.js`、轮询状态文件并转发 progress notification。runner 独立跑 `claude -p --output-format stream-json`,逐事件写 `state.json`/`live.md`,结束写 `result.json` 并回存 session_id 到 `conversations.json`。所有状态在 `~/.fable-advisor/`(测试时用 `FABLE_HOME` 重定向),server 重启不影响在跑任务。

**Tech Stack:** Node ≥18(纯 ESM)、`@modelcontextprotocol/sdk`、`zod`、`node:test`(无新增依赖)。测试用 fake-claude 脚本模拟 stream-json,不打真实 API。

**设计文档:** `docs/plans/2026-06-10-fable-advisor-v2-design.md`(必读)

---

## Task 0: git 仓库初始化

**Files:** Create: `.gitignore`

**Step 1:** 在 `<repo-root>` 下:

```bash
git init
printf 'node_modules/\n.DS_Store\n' > .gitignore
git add .gitignore docs/ fable-advisor/package.json fable-advisor/package-lock.json fable-advisor/server.js fable-advisor/README.md
git commit -m "chore: import fable-advisor v1 and v2 design doc"
```

**Step 2:** `git log --oneline` 确认 1 个 commit。

---

## Task 1: lib/store.js — 路径与状态存取

**Files:**
- Create: `fable-advisor/lib/store.js`
- Test: `fable-advisor/tests/store.test.js`
- Modify: `fable-advisor/package.json`(加 `"scripts": {"test": "node --test tests/"}`)

**Step 1: 写失败测试** `tests/store.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FABLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fable-test-"));
const store = await import("../lib/store.js");

test("conversation roundtrip", () => {
  store.setConversation("/proj", "arch-debate", { session_id: "s1", mode: "discuss", turns: 1 });
  assert.equal(store.getConversation("/proj", "arch-debate").session_id, "s1");
  store.setConversation("/proj", "arch-debate", { session_id: "s2", turns: 2 });
  const c = store.getConversation("/proj", "arch-debate");
  assert.equal(c.session_id, "s2");
  assert.equal(c.mode, "discuss"); // merge 不丢旧字段
  assert.equal(store.getConversation("/proj", "other"), null);
});

test("list and delete conversations", () => {
  store.setConversation("/proj2", "default", { session_id: "x" });
  const forProj = store.listConversations("/proj");
  assert.ok(forProj.every((c) => c.directory === "/proj"));
  assert.ok(store.listConversations().length >= 2);
  store.deleteConversation("/proj2", "default");
  assert.equal(store.getConversation("/proj2", "default"), null);
});

test("runs listing sorts by id, latest wins", () => {
  fs.mkdirSync(store.runDir("20260610-1200-review-aaaa"), { recursive: true });
  fs.mkdirSync(store.runDir("20260610-1300-audit-bbbb"), { recursive: true });
  assert.equal(store.latestRunId(), "20260610-1300-audit-bbbb");
});

test("readJson fallback on missing/corrupt", () => {
  assert.equal(store.readJson("/nonexistent.json", null), null);
});
```

**Step 2:** `cd fable-advisor && npm test` → FAIL(Cannot find module lib/store.js)

**Step 3: 实现** `lib/store.js`:

```js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function baseDir() {
  return process.env.FABLE_HOME || path.join(os.homedir(), ".fable-advisor");
}
export function runsDir() { return path.join(baseDir(), "runs"); }
export function runDir(runId) { return path.join(runsDir(), runId); }
export function conversationsPath() { return path.join(baseDir(), "conversations.json"); }

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
// 写临时文件再 rename,读方永远不会看到半截 JSON
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const convKey = (directory, name) => `${directory}::${name}`;

export function getConversation(directory, name) {
  return readJson(conversationsPath(), {})[convKey(directory, name)] ?? null;
}
export function setConversation(directory, name, data) {
  const all = readJson(conversationsPath(), {});
  const key = convKey(directory, name);
  all[key] = { ...(all[key] ?? {}), ...data };
  writeJson(conversationsPath(), all);
}
export function deleteConversation(directory, name) {
  const all = readJson(conversationsPath(), {});
  delete all[convKey(directory, name)];
  writeJson(conversationsPath(), all);
}
export function listConversations(directory = null) {
  return Object.entries(readJson(conversationsPath(), {}))
    .filter(([k]) => !directory || k.startsWith(`${directory}::`))
    .map(([k, v]) => {
      const sep = k.indexOf("::");
      return { directory: k.slice(0, sep), name: k.slice(sep + 2), ...v };
    });
}

export function listRuns() {
  try { return fs.readdirSync(runsDir()).sort(); } catch { return []; }
}
export function latestRunId() {
  const runs = listRuns();
  return runs.length ? runs[runs.length - 1] : null;
}
```

**Step 4:** `npm test` → PASS
**Step 5:** `git add -A && git commit -m "feat: file-backed store for runs and named conversations"`

---

## Task 2: lib/modes.js — 5 种模式预设

**Files:**
- Create: `fable-advisor/lib/modes.js`
- Test: `fable-advisor/tests/modes.test.js`

**Step 1: 失败测试** `tests/modes.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { systemPromptFor, MODE_NAMES } from "../lib/modes.js";

test("five modes exist", () => {
  assert.deepEqual(MODE_NAMES.sort(),
    ["advise", "audit", "discuss", "project_review", "review"]);
});

test("each mode prompt is distinct and carries common rules", () => {
  const prompts = MODE_NAMES.map(systemPromptFor);
  assert.equal(new Set(prompts).size, 5);
  for (const p of prompts) {
    assert.match(p, /file:line/);
    assert.match(p, /same language/i);
  }
});

test("unknown mode falls back to advise", () => {
  assert.equal(systemPromptFor("nope"), systemPromptFor("advise"));
});
```

**Step 2:** `npm test` → FAIL
**Step 3: 实现** `lib/modes.js`:

```js
const COMMON = `

General rules:
- Respond in the same language the user's prompt is written in.
- When referencing code, always cite file:line.
- You have read-only access (Read/Grep/Glob) plus WebFetch/WebSearch; explore the code yourself before judging.
- Your final message is delivered verbatim to another engineer's AI assistant; make it self-contained and actionable.`;

const MODES = {
  review: `You are a meticulous senior code reviewer focused on IMPLEMENTATION CORRECTNESS.
Hunt for bugs, boundary conditions, off-by-one errors, error-handling gaps, race conditions, and code that does not do what it claims.
Output findings grouped by severity (critical / major / minor), each with file:line, why it is wrong, and a concrete fix.
Do not comment on macro architecture unless it directly causes a correctness bug. End with a one-paragraph verdict.`,
  project_review: `You are a senior project reviewer looking at the MACRO level, like a journal reviewer assessing a whole project.
Evaluate architecture, module boundaries, methodology and experimental design, technical debt, and directional risks.
Do not nitpick individual lines. Output: strengths, weaknesses, risks, and prioritized recommendations.`,
  audit: `You are an adversarial auditor performing a checklist-driven sweep for security issues, data-correctness hazards, and quality problems.
Be harsh and exhaustive; prefer false positives over missed problems. For every item state: location (file:line), the threat or failure scenario, and remediation.
Conclude with a table summary: total checked areas, findings per severity.`,
  discuss: `You are a sharp discussion and debate partner.
Take clear positions and defend them; push back directly when you disagree — never agree just to be agreeable.
Ground every opinion in evidence: the code at hand, documentation, or first principles. Concede only to better arguments, and say so explicitly when you do.`,
  advise: `You are a pragmatic senior technical advisor.
Lay out the viable options with honest trade-offs, then give ONE clear recommendation and the reasoning behind it.
Flag what you would need to verify before committing, and the cheapest way to verify it.`,
};

export const MODE_NAMES = Object.keys(MODES);
export function systemPromptFor(mode) {
  return (MODES[mode] ?? MODES.advise) + COMMON;
}
```

**Step 4:** `npm test` → PASS
**Step 5:** `git add -A && git commit -m "feat: five advisor mode presets"`

---

## Task 3: lib/events.js — stream-json 事件翻译

**Files:**
- Create: `fable-advisor/lib/events.js`
- Test: `fable-advisor/tests/events.test.js`

背景:`claude -p --output-format stream-json --verbose` 每行一个 JSON 事件:
`{"type":"system","subtype":"init",...}`、`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{...}} | {"type":"text","text":"..."}]}}`、`{"type":"user",...}`(工具结果)、`{"type":"result",...}`(终态,含 result/session_id/usage)。

**Step 1: 失败测试** `tests/events.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeEvent } from "../lib/events.js";

test("init event", () => {
  assert.deepEqual(describeEvent({ type: "system", subtype: "init" }),
    [{ action: "session started" }]);
});

test("assistant tool_use becomes action, text becomes text", () => {
  const items = describeEvent({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Read", input: { file_path: "/p/src/a.py" } },
    { type: "tool_use", name: "Grep", input: { pattern: "def train" } },
    { type: "text", text: "Looking at the trainer..." },
  ]}});
  assert.deepEqual(items, [
    { action: "Read /p/src/a.py" },
    { action: "Grep def train" },
    { text: "Looking at the trainer..." },
  ]);
});

test("result event marks done", () => {
  const [item] = describeEvent({ type: "result", result: "final", session_id: "s" });
  assert.equal(item.done, true);
  assert.equal(item.result.session_id, "s");
});

test("uninteresting events yield empty list", () => {
  assert.deepEqual(describeEvent({ type: "user", message: {} }), []);
});
```

**Step 2:** FAIL → **Step 3: 实现** `lib/events.js`:

```js
function toolTarget(input = {}) {
  return input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? "";
}

// 一行 stream-json 事件 → 渲染项列表:{action} 进度行 | {text} 正文 | {done,result} 终态
export function describeEvent(evt) {
  if (evt?.type === "system" && evt.subtype === "init") return [{ action: "session started" }];
  if (evt?.type === "assistant") {
    const items = [];
    for (const block of evt.message?.content ?? []) {
      if (block.type === "tool_use") items.push({ action: `${block.name} ${toolTarget(block.input)}`.trim() });
      else if (block.type === "text" && block.text) items.push({ text: block.text });
    }
    return items;
  }
  if (evt?.type === "result") return [{ done: true, result: evt }];
  return [];
}
```

**Step 4:** PASS → **Step 5:** `git commit -am "feat: stream-json event translation"`

---

## Task 4: tests/fake-claude.js — 测试替身

**Files:** Create: `fable-advisor/tests/fake-claude.js`(可执行)

不是 TDD 对象(它本身是测试基础设施),直接实现:

```js
#!/usr/bin/env node
// 模拟 claude -p --output-format stream-json。FAKE_MODE 控制行为:
//   ok(默认)— 两轮工具+文本后成功;resume 时 result 带 resumed:true 标记文本
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
```

`chmod +x tests/fake-claude.js`,然后 `git commit -am "test: fake claude binary emitting stream-json"`

---

## Task 5: runner.js — 执行器(核心)

**Files:**
- Create: `fable-advisor/runner.js`
- Test: `fable-advisor/tests/runner.test.js`

约定:`node runner.js <specPath>`;spec JSON 含 `{runId, prompt, directory, mode, conversation, fresh, files, resumeSessionId}`。环境变量:`FABLE_BASE_URL/FABLE_AUTH_TOKEN/FABLE_MODEL/FABLE_CLAUDE_BIN/FABLE_HOME/FABLE_STALL_MINUTES/FABLE_RETRY_DELAYS_MS`(后两个测试用来加速)。

**Step 1: 失败测试** `tests/runner.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, "..");
const FAKE = path.join(ROOT, "tests", "fake-claude.js");

function setup(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fable-run-"));
  return { home, env: { ...process.env, FABLE_HOME: home, FABLE_CLAUDE_BIN: FAKE,
    FABLE_BASE_URL: "https://x", FABLE_AUTH_TOKEN: "sk-x",
    FABLE_RETRY_DELAYS_MS: "20,20,20", FABLE_STALL_MINUTES: "1", ...extraEnv } };
}

async function launch(env, home, spec) {
  const runId = spec.runId;
  const dir = path.join(home, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const specPath = path.join(dir, "spec.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  await run("node", [path.join(ROOT, "runner.js"), specPath], { env });
  return dir;
}

const baseSpec = { prompt: "review this", directory: "/tmp", mode: "review",
  conversation: "default", fresh: false, files: [], resumeSessionId: null };

test("happy path: state/live/result written, conversation saved", async () => {
  const { home, env } = setup();
  const dir = await launch(env, home, { ...baseSpec, runId: "r1-review-aaaa" });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json")));
  assert.equal(state.status, "done");
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json")));
  assert.equal(result.text, "FRESH-ANSWER");
  assert.equal(result.session_id, "fake-session-2");
  const live = fs.readFileSync(path.join(dir, "live.md"), "utf8");
  assert.match(live, /Read src\/a\.py/);
  assert.match(live, /fresh analysis/);
  const convs = JSON.parse(fs.readFileSync(path.join(home, "conversations.json")));
  assert.equal(convs["/tmp::default"].session_id, "fake-session-2");
});

test("resume passes --resume and fake acknowledges", async () => {
  const { home, env } = setup();
  const dir = await launch(env, home,
    { ...baseSpec, runId: "r2-review-bbbb", resumeSessionId: "fake-session-2" });
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json")));
  assert.equal(result.text, "RESUMED-ANSWER");
});

test("429 twice then success via retries", async () => {
  const { home, env } = setup({ FAKE_MODE: "429twice",
    FAKE_STATE: path.join(os.tmpdir(), `fake-429-${Date.now()}`) });
  const dir = await launch(env, home, { ...baseSpec, runId: "r3-review-cccc" });
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json")));
  assert.equal(state.status, "done");
  assert.match(fs.readFileSync(path.join(dir, "live.md"), "utf8"), /retry/i);
});

test("stall watchdog kills hung child and marks failed", async () => {
  const { home, env } = setup({ FAKE_MODE: "hang", FABLE_STALL_MINUTES: "0.005" }); // 300ms
  const dir = await launch(env, home, { ...baseSpec, runId: "r4-review-dddd" })
    .catch(() => path.join(home, "runs", "r4-review-dddd")); // runner 以非 0 退出也接受
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json")));
  assert.equal(state.status, "failed");
  assert.match(state.action, /stall/i);
});
```

**Step 2:** `npm test` → 新测试全 FAIL

**Step 3: 实现** `runner.js`:

```js
#!/usr/bin/env node
// 独立执行器:跑一次 Fable 咨询,状态全部落盘,可被 detach。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { runDir, writeJson, setConversation, getConversation } from "./lib/store.js";
import { systemPromptFor } from "./lib/modes.js";
import { describeEvent } from "./lib/events.js";

const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const dir = runDir(spec.runId);
const livePath = path.join(dir, "live.md");
const statePath = path.join(dir, "state.json");

const MODEL = process.env.FABLE_MODEL || "claude-fable-5[1m]";
const CLAUDE_BIN = process.env.FABLE_CLAUDE_BIN || "claude";
const STALL_MS = (Number(process.env.FABLE_STALL_MINUTES) || 10) * 60_000;
const RETRY_DELAYS = (process.env.FABLE_RETRY_DELAYS_MS || "5000,15000,30000")
  .split(",").map(Number);
const RETRYABLE = /429|rate.?limit|overloaded|service unavailable|529|ECONNRESET|ETIMEDOUT/i;

let state = { status: "running", pid: process.pid, turn: 0, action: "starting",
  started: Date.now(), updated: Date.now(), runId: spec.runId,
  conversation: spec.conversation, directory: spec.directory, mode: spec.mode };
const update = (patch) => { state = { ...state, ...patch, updated: Date.now() }; writeJson(statePath, state); };
const live = (s) => fs.appendFileSync(livePath, s);

let child = null;
let finished = false;
process.on("SIGTERM", () => {
  finished = true;
  if (child) try { child.kill("SIGKILL"); } catch {}
  update({ status: "cancelled", action: "cancelled by user" });
  process.exit(0);
});

function fullPrompt() {
  let p = spec.prompt;
  if (spec.files?.length) p += `\n\nFocus on these files/paths:\n${spec.files.map((f) => `- ${f}`).join("\n")}`;
  return p;
}

function buildArgs(resumeId) {
  const args = ["-p", fullPrompt(), "--model", MODEL, "--setting-sources", "",
    "--allowedTools", "Read", "Grep", "Glob", "WebFetch", "WebSearch",
    "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit",
    "--append-system-prompt", systemPromptFor(spec.mode),
    "--output-format", "stream-json", "--verbose"];
  if (resumeId) args.push("--resume", resumeId);
  return args;
}

function attempt(resumeId) {
  return new Promise((resolve) => {
    const env = { ...process.env,
      ANTHROPIC_BASE_URL: process.env.FABLE_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: process.env.FABLE_AUTH_TOKEN,
      ANTHROPIC_MODEL: MODEL, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    delete env.ANTHROPIC_API_KEY;

    child = spawn(CLAUDE_BIN, buildArgs(resumeId),
      { cwd: spec.directory, env, stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "", resultEvt = null;
    let stall = setTimeout(onStall, STALL_MS);
    function bump() { clearTimeout(stall); stall = setTimeout(onStall, STALL_MS); }
    function onStall() {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ stalled: true });
    }

    child.stderr.on("data", (d) => { stderr += d; });
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      bump();
      let evt; try { evt = JSON.parse(line); } catch { return; }
      for (const item of describeEvent(evt)) {
        if (item.action) {
          if (/^(Read|Grep|Glob|WebFetch|WebSearch)/.test(item.action)) state.turn += 1;
          update({ action: item.action });
          live(`\n> [${new Date().toISOString().slice(11, 19)}] ${item.action}\n`);
        } else if (item.text) {
          update({ action: "writing analysis" });
          live(`\n${item.text}\n`);
        } else if (item.done) resultEvt = item.result;
      }
    });
    child.on("close", (code) => { clearTimeout(stall); resolve({ code, stderr, resultEvt }); });
  });
}

fs.mkdirSync(dir, { recursive: true });
update({});
live(`# Fable run ${spec.runId}\n\nmode: ${spec.mode} · conversation: ${spec.conversation} · dir: ${spec.directory}\n\n## Prompt\n\n${spec.prompt}\n\n## Transcript\n`);

let resumeId = spec.resumeSessionId;
let outcome = null;
for (let i = 0; i <= RETRY_DELAYS.length; i++) {
  if (i > 0) {
    update({ action: `rate limited, retry ${i}/${RETRY_DELAYS.length} in ${RETRY_DELAYS[i - 1]}ms` });
    live(`\n> retry ${i}/${RETRY_DELAYS.length}\n`);
    await new Promise((r) => setTimeout(r, RETRY_DELAYS[i - 1]));
  }
  outcome = await attempt(resumeId);
  if (finished) process.exit(0);
  if (outcome.stalled) {
    update({ status: "failed", action: `stalled: no events for ${STALL_MS / 60000} min` });
    process.exit(1);
  }
  if (outcome.resultEvt && !outcome.resultEvt.is_error) break;
  const failText = outcome.resultEvt?.result || outcome.stderr || `exit ${outcome.code}`;
  // resume 失效:中转把旧 session 清了 → 降级新开对话重试一次
  if (resumeId && /no conversation found|session.*not found/i.test(failText)) {
    live(`\n> session expired upstream, starting fresh conversation\n`);
    resumeId = null; i -= 1; continue;
  }
  if (!RETRYABLE.test(failText) || i === RETRY_DELAYS.length) {
    update({ status: "failed", action: failText.slice(0, 200) });
    live(`\n## FAILED\n\n${failText.slice(0, 2000)}\n`);
    process.exit(1);
  }
}

const r = outcome.resultEvt;
writeJson(path.join(dir, "result.json"), {
  text: r.result ?? "", session_id: r.session_id, cost_usd: r.total_cost_usd,
  usage: r.usage, num_turns: r.num_turns, duration_ms: Date.now() - state.started,
  conversation: spec.conversation, mode: spec.mode, resumed: Boolean(spec.resumeSessionId),
});
const prev = getConversation(spec.directory, spec.conversation);
setConversation(spec.directory, spec.conversation, {
  session_id: r.session_id, mode: spec.mode, turns: (prev?.turns ?? 0) + 1,
  last_used: new Date().toISOString(), summary: spec.prompt.slice(0, 120),
});
update({ status: "done", action: "complete" });
```

**Step 4:** `npm test` → PASS(4 个 runner 测试 + 之前的全部)
**Step 5:** `git add -A && git commit -m "feat: detachable runner with live state, retries, stall watchdog"`

---

## Task 6: server.js v2 — 5 个 MCP 工具

**Files:**
- Modify: `fable-advisor/server.js`(整体重写)
- Test: `fable-advisor/tests/server.test.js`

**Step 1: 失败测试** `tests/server.test.js`(用子进程跑 server,管道发 JSON-RPC):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");

function startServer(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fable-srv-"));
  const proc = spawn("node", [path.join(ROOT, "server.js")], {
    env: { ...process.env, FABLE_HOME: home,
      FABLE_CLAUDE_BIN: path.join(ROOT, "tests", "fake-claude.js"),
      FABLE_BASE_URL: "https://x", FABLE_AUTH_TOKEN: "sk-x",
      FABLE_RETRY_DELAYS_MS: "20,20,20", ...extraEnv },
  });
  let id = 0; const pending = new Map();
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      try { const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      } catch {}
    }
  });
  const send = (method, params) => new Promise((res) => {
    const msgId = ++id;
    pending.set(msgId, res);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
  });
  return { proc, home, send,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args });
      return { isError: r.result?.isError ?? false, text: r.result?.content?.[0]?.text ?? "" };
    },
    init: async () => {
      await send("initialize", { protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "t", version: "0" } });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    } };
}

test("tools/list exposes five tools", async (t) => {
  const s = startServer(); t.after(() => s.proc.kill());
  await s.init();
  const r = await s.send("tools/list", {});
  assert.deepEqual(r.result.tools.map((x) => x.name).sort(),
    ["consult_fable", "fable_cancel", "fable_conversations", "fable_result", "fable_status"]);
});

test("blocking consult returns answer; conversations lists it", async (t) => {
  const s = startServer(); t.after(() => s.proc.kill());
  await s.init();
  const r = await s.call("consult_fable",
    { prompt: "hi", directory: os.tmpdir(), mode: "review" });
  assert.match(r.text, /FRESH-ANSWER/);
  const list = await s.call("fable_conversations", { directory: os.tmpdir() });
  assert.match(list.text, /default/);
});

test("background consult: immediate run_id, then status → result", async (t) => {
  const s = startServer(); t.after(() => s.proc.kill());
  await s.init();
  const r = await s.call("consult_fable",
    { prompt: "hi", directory: os.tmpdir(), background: true });
  const runId = r.text.match(/run_id: (\S+)/)[1];
  assert.ok(runId);
  let done = false;
  for (let i = 0; i < 50 && !done; i++) {
    await new Promise((x) => setTimeout(x, 100));
    const st = await s.call("fable_status", { run_id: runId });
    done = /done/.test(st.text);
  }
  assert.ok(done, "run should finish");
  const res = await s.call("fable_result", { run_id: runId });
  assert.match(res.text, /FRESH-ANSWER/);
});

test("cancel kills a hung background run", async (t) => {
  const s = startServer({ FAKE_MODE: "hang", FABLE_STALL_MINUTES: "10" });
  t.after(() => s.proc.kill());
  await s.init();
  const r = await s.call("consult_fable",
    { prompt: "hi", directory: os.tmpdir(), background: true });
  const runId = r.text.match(/run_id: (\S+)/)[1];
  await new Promise((x) => setTimeout(x, 300));
  await s.call("fable_cancel", { run_id: runId });
  await new Promise((x) => setTimeout(x, 300));
  const st = await s.call("fable_status", { run_id: runId });
  assert.match(st.text, /cancelled/);
});
```

**Step 2:** FAIL → **Step 3: 重写** `server.js`:

```js
#!/usr/bin/env node
// fable-advisor v2 — MCP stdio server(薄壳:状态都在文件里,执行都在 runner 里)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as store from "./lib/store.js";
import { MODE_NAMES } from "./lib/modes.js";

if (!process.env.FABLE_BASE_URL || !process.env.FABLE_AUTH_TOKEN) {
  console.error("fable-advisor: FABLE_BASE_URL and FABLE_AUTH_TOKEN must be set");
  process.exit(1);
}
const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "runner.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ isError: true, content: [{ type: "text", text }] });

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function readState(runId) {
  const st = store.readJson(path.join(store.runDir(runId), "state.json"));
  if (!st) return null;
  // 孤儿检测:声称在跑但 60s 没更新且进程已死 → 判失败
  if (st.status === "running" && Date.now() - st.updated > 60_000 && !pidAlive(st.pid)) {
    const dead = { ...st, status: "failed", action: "runner died unexpectedly" };
    store.writeJson(path.join(store.runDir(runId), "state.json"), dead);
    return dead;
  }
  return st;
}

function resolveRunId(runId) { return runId || store.latestRunId(); }

function statusText(runId) {
  const st = readState(runId);
  if (!st) return `No run found${runId ? ` for ${runId}` : ""}.`;
  const elapsed = Math.round((Date.now() - st.started) / 1000);
  const livePath = path.join(store.runDir(runId), "live.md");
  let tail = "";
  try { tail = fs.readFileSync(livePath, "utf8").split("\n").slice(-6).join("\n"); } catch {}
  return `run_id: ${runId}\nstatus: ${st.status}\nmode: ${st.mode} · conversation: ${st.conversation}\n` +
    `steps so far: ${st.turn} · elapsed: ${elapsed}s\ncurrent: ${st.action}\n` +
    `live transcript: tail -f ${livePath}\n\nrecent output:\n${tail}`;
}

function launchRun(args) {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  const runId = `${ts}-${args.mode}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = store.runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const conv = args.fresh ? null : store.getConversation(args.directory, args.conversation);
  const spec = { runId, prompt: args.prompt, directory: args.directory, mode: args.mode,
    conversation: args.conversation, fresh: args.fresh, files: args.files ?? [],
    resumeSessionId: conv?.session_id ?? null };
  const specPath = path.join(dir, "spec.json");
  store.writeJson(specPath, spec);
  store.writeJson(path.join(dir, "state.json"), { status: "running", pid: 0, turn: 0,
    action: "launching runner", started: Date.now(), updated: Date.now(),
    runId, conversation: args.conversation, directory: args.directory, mode: args.mode });
  // detached + 自成进程组:server/主会话死了它照跑;cancel 用 kill(-pid) 收割全组
  const child = spawn(process.execPath, [RUNNER, specPath],
    { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return { runId, resumed: Boolean(spec.resumeSessionId) };
}

const server = new McpServer({ name: "fable-advisor", version: "2.0.0" });

server.registerTool("consult_fable", {
  title: "Consult Fable",
  description:
    "Consult Fable (a strong reviewer model on a separate endpoint) for code review, project review, " +
    "audit, debate/discussion, or advice. Fable explores the given directory itself (read-only) and can browse the web. " +
    "Conversations are persistent: pass the same `conversation` name to continue a previous thread (Fable remembers context), " +
    "a new name (or fresh=true) to start over. Slow (minutes); for big jobs set background=true and poll fable_status.",
  inputSchema: {
    prompt: z.string().describe("What to review/audit/discuss/ask. Self-contained; include context Fable can't read from disk."),
    directory: z.string().describe("Absolute path of the project directory Fable may read."),
    mode: z.enum(MODE_NAMES).default("advise").describe(
      "review=implementation correctness; project_review=macro architecture/methodology; " +
      "audit=adversarial security/quality sweep; discuss=debate partner; advise=options+recommendation"),
    conversation: z.string().default("default").describe("Named thread. Same name = Fable continues with memory of prior turns."),
    fresh: z.boolean().default(false).describe("Discard this conversation's history and start anew."),
    files: z.array(z.string()).optional().describe("Files/subdirs (relative to directory) to focus on."),
    background: z.boolean().default(false).describe("true: return run_id immediately; poll fable_status / fetch fable_result."),
  },
}, async (args, extra) => {
  if (!path.isAbsolute(args.directory) || !fs.existsSync(args.directory))
    return fail(`directory must be an existing absolute path, got: ${args.directory}`);
  const { runId, resumed } = launchRun(args);
  const livePath = path.join(store.runDir(runId), "live.md");

  if (args.background) {
    return ok(`Started background run.\nrun_id: ${runId}\n` +
      `conversation: ${args.conversation}${resumed ? " (resumed)" : " (new)"}\n` +
      `Watch live: tail -f ${livePath}\n` +
      `Poll with fable_status, fetch the answer with fable_result.`);
  }

  // 阻塞模式:轮询状态文件,把动作变化转成 progress notification
  const progressToken = extra._meta?.progressToken;
  let lastUpdated = 0, progress = 0;
  for (;;) {
    await sleep(500);
    const st = readState(runId);
    if (!st) return fail(`run ${runId} state vanished`);
    if (st.updated !== lastUpdated && progressToken !== undefined) {
      lastUpdated = st.updated;
      const elapsed = Math.round((Date.now() - st.started) / 1000);
      await extra.sendNotification({ method: "notifications/progress",
        params: { progressToken, progress: ++progress,
          message: `step ${st.turn} · ${st.action} · ${elapsed}s` } }).catch(() => {});
    }
    if (st.status === "running") continue;
    if (st.status !== "done")
      return fail(`Run ${st.status}: ${st.action}\nPartial transcript: ${livePath}`);
    const r = store.readJson(path.join(store.runDir(runId), "result.json"), {});
    return ok(`${r.text}\n\n---\nconversation: ${r.conversation}${r.resumed ? " (resumed)" : " (new)"} · mode: ${r.mode} · ` +
      `turns total: ${store.getConversation(args.directory, args.conversation)?.turns} · ` +
      `$${r.cost_usd?.toFixed(3)} · ${Math.round((r.duration_ms ?? 0) / 1000)}s · run_id: ${runId}`);
  }
});

server.registerTool("fable_status", {
  title: "Fable run status",
  description: "Check progress of a Fable run (current step, elapsed, recent output). Defaults to the latest run.",
  inputSchema: { run_id: z.string().optional() },
}, async ({ run_id }) => {
  const id = resolveRunId(run_id);
  return id ? ok(statusText(id)) : ok("No runs yet.");
});

server.registerTool("fable_result", {
  title: "Fable run result",
  description: "Fetch the final answer of a (background) Fable run. Defaults to the latest run.",
  inputSchema: { run_id: z.string().optional() },
}, async ({ run_id }) => {
  const id = resolveRunId(run_id);
  if (!id) return ok("No runs yet.");
  const r = store.readJson(path.join(store.runDir(id), "result.json"));
  if (!r) return ok(`Not finished.\n\n${statusText(id)}`);
  return ok(`${r.text}\n\n---\nconversation: ${r.conversation} · mode: ${r.mode} · $${r.cost_usd?.toFixed(3)} · run_id: ${id}`);
});

server.registerTool("fable_conversations", {
  title: "Fable conversations",
  description: "List or delete named Fable conversation threads.",
  inputSchema: {
    directory: z.string().optional().describe("Filter by project directory."),
    action: z.enum(["list", "delete"]).default("list"),
    name: z.string().optional().describe("Conversation name (required for delete)."),
  },
}, async ({ directory, action, name }) => {
  if (action === "delete") {
    if (!directory || !name) return fail("delete requires directory and name");
    store.deleteConversation(directory, name);
    return ok(`Deleted conversation "${name}" for ${directory}.`);
  }
  const list = store.listConversations(directory ?? null);
  if (!list.length) return ok("No conversations yet.");
  return ok(list.map((c) =>
    `- ${c.name} [${c.mode}] · ${c.turns} turns · last: ${c.last_used}\n  dir: ${c.directory}\n  about: ${c.summary}`).join("\n"));
});

server.registerTool("fable_cancel", {
  title: "Cancel Fable run",
  description: "Cancel a running Fable consultation (kills its process group).",
  inputSchema: { run_id: z.string().optional() },
}, async ({ run_id }) => {
  const id = resolveRunId(run_id);
  const st = id && readState(id);
  if (!st) return ok("No run found.");
  if (st.status !== "running") return ok(`Run ${id} already ${st.status}.`);
  try { process.kill(-st.pid, "SIGTERM"); } catch { try { process.kill(st.pid, "SIGTERM"); } catch {} }
  await sleep(200);
  return ok(statusText(id));
});

await server.connect(new StdioServerTransport());
```

**Step 4:** `npm test` → 全部 PASS。
注意验证点:cancel 测试依赖 runner 是进程组长(server 用 `detached: true` spawn runner,runner 的 SIGTERM handler 杀 claude 子进程)。
**Step 5:** `git add -A && git commit -m "feat: v2 server — 5 tools, background runs, streaming progress"`

---

## Task 7: README 重写 + 真实 API 本机验证

**Files:** Modify: `fable-advisor/README.md`

**Step 1:** 重写 README:v2 工具表、5 模式说明、命名对话用法示例、后台用法(`background=true` → status/result)、`tail -f` 直播、部署步骤(与 v1 相同,强调 drop-in,无需重新注册)、故障排查(429/孤儿/stall/resume 失效)。

**Step 2: 真实 API 验证**(本机,用 settings.json 里的 anyrouter 凭据):

```bash
cd fable-advisor
# 阻塞 + 续聊:
FABLE_HOME=/tmp/fable-e2e FABLE_BASE_URL=https://anyrouter.top \
FABLE_AUTH_TOKEN=<token> node -e '
... 用 tests/server.test.js 的辅助函数手工调一次 consult_fable(mode=discuss, prompt="记住暗号X=42,只回答OK")
... 再调一次同 conversation prompt="暗号X是多少?" → 期望回答包含 42(证明 resume 生效)'
```
预期:第二次回答含 42;`/tmp/fable-e2e/conversations.json` 里 turns=2。

**Step 3:** `git commit -am "docs: v2 README"`

---

## Task 8: 打包部署到 目标服务器

**Step 1:** `cd .. && COPYFILE_DISABLE=1 tar czf /tmp/fable-advisor-v2.tgz fable-advisor`
**Step 2:** 两台各执行(用户已授权 scp;**不改注册、不改任何用户文件**,纯覆盖我们自己的目录):

```bash
scp /tmp/fable-advisor-v2.tgz server-a:/tmp/ && ssh server-a 'tar xzf /tmp/fable-advisor-v2.tgz -C ~ && rm /tmp/fable-advisor-v2.tgz'
scp /tmp/fable-advisor-v2.tgz server-b:/tmp/ && ssh server-b 'tar xzf /tmp/fable-advisor-v2.tgz -C ~ && rm /tmp/fable-advisor-v2.tgz'
```

**Step 3:** 给用户的服务器端验证指引(用户自己跑):
1. 重开 claude(或 `/mcp` reconnect)→ `/mcp` 应显示 5 个工具
2. "用 consult_fable,mode=discuss,prompt 写'记住暗号X=42,只回答OK'" → 再来一轮"暗号是多少" → 答 42 = 续聊 OK
3. "background=true 让 Fable audit 一下这个项目" → 立即拿到 run_id 和 tail 命令 → 另开终端 tail -f 看直播 → 问主模型"Fable 到哪步了"(fable_status)→ 完成后 fable_result
4. 状态行验证:阻塞模式调用时观察工具行是否滚动显示 `step N · Read xxx · 时长`

**Step 4:** `git commit -am "chore: v2 deployed to target servers"`(如有零散改动)

---

## 风险与回退

- **--resume 在中转端的兼容性**:Task 7 真实验证是关键关卡;若 anyrouter 不保 session,runner 已有降级逻辑(自动新开+注明)。
- **progress notification 在 Claude Code 的渲染**:若状态行不刷新(客户端没传 progressToken),功能不受损,只是没有实时行;live.md + fable_status 仍可用。
- **回退**:v1 的 server.js 在 git 历史里,`git checkout <v1-commit> -- fable-advisor/server.js` 重新打包即可回退;服务器端注册完全不用动。
