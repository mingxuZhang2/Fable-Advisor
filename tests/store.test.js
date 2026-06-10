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
