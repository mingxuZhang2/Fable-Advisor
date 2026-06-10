import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FABLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "fable-test-"));
const store = await import("../lib/store.js");

// 每个用例自播种:先清空 conversations.json,不依赖前序用例残留
function resetConversations() {
  fs.rmSync(store.conversationsPath(), { force: true });
}

test("conversation roundtrip", () => {
  resetConversations();
  store.setConversation("/proj", "arch-debate", { session_id: "s1", mode: "discuss", turns: 1 });
  assert.equal(store.getConversation("/proj", "arch-debate").session_id, "s1");
  store.setConversation("/proj", "arch-debate", { session_id: "s2", turns: 2 });
  const c = store.getConversation("/proj", "arch-debate");
  assert.equal(c.session_id, "s2");
  assert.equal(c.mode, "discuss"); // merge 不丢旧字段
  assert.equal(c.turns, 2);
  assert.equal(store.getConversation("/proj", "other"), null);
});

test("list and delete conversations", () => {
  resetConversations();
  store.setConversation("/proj", "arch-debate", { session_id: "s1" });
  store.setConversation("/proj2", "default", { session_id: "x" });
  assert.deepEqual(store.listConversations("/proj"),
    [{ directory: "/proj", name: "arch-debate", session_id: "s1" }]);
  assert.deepEqual(store.listConversations().sort((a, b) => a.directory.localeCompare(b.directory)), [
    { directory: "/proj", name: "arch-debate", session_id: "s1" },
    { directory: "/proj2", name: "default", session_id: "x" },
  ]);
  store.deleteConversation("/proj2", "default");
  assert.equal(store.getConversation("/proj2", "default"), null);
  assert.deepEqual(store.listConversations("/proj2"), []);
});

test("lock contention smoke: sequential writes to same directory both persist", () => {
  resetConversations();
  store.setConversation("/proj", "a", { session_id: "a1" });
  store.setConversation("/proj", "b", { session_id: "b1" });
  assert.equal(store.getConversation("/proj", "a").session_id, "a1");
  assert.equal(store.getConversation("/proj", "b").session_id, "b1");
  // 锁释放干净:.lock 目录不存在
  assert.equal(fs.existsSync(store.conversationsPath() + ".lock"), false);
});

test("runs listing sorts by id, latest wins, ignores non-run entries", () => {
  fs.mkdirSync(store.runDir("202606101200-review-aaaa"), { recursive: true });
  fs.mkdirSync(store.runDir("202606101300-audit-bbbb"), { recursive: true });
  fs.mkdirSync(store.runDir("not-a-run"), { recursive: true });
  fs.writeFileSync(path.join(store.runsDir(), "202606101400-stray.txt"), "file, not dir");
  assert.deepEqual(store.listRuns(),
    ["202606101200-review-aaaa", "202606101300-audit-bbbb"]);
  assert.equal(store.latestRunId(), "202606101300-audit-bbbb");
});

test("readJson fallback on missing file", () => {
  assert.equal(store.readJson("/nonexistent.json", null), null);
});

test("readJson on corrupt file: fallback + file renamed aside", () => {
  const file = path.join(store.baseDir(), "broken.json");
  fs.mkdirSync(store.baseDir(), { recursive: true });
  fs.writeFileSync(file, "{ not valid json !!");
  assert.deepEqual(store.readJson(file, { ok: true }), { ok: true });
  assert.equal(fs.existsSync(file), false); // 原文件被挪走
  const aside = fs.readdirSync(store.baseDir()).filter((n) => n.startsWith("broken.json.corrupt-"));
  assert.equal(aside.length, 1);
});
