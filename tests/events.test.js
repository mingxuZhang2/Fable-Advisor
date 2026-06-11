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
  assert.equal(item.event.session_id, "s");
});

test("uninteresting events yield empty list", () => {
  assert.deepEqual(describeEvent({ type: "user", message: {} }), []);
});

test("outputTokens: assistant/stream_event/result extraction", async () => {
  const { outputTokens } = await import("../lib/events.js");
  assert.deepEqual(outputTokens({ type: "assistant", message: { usage: { output_tokens: 21 } } }),
    { completed: 21 });
  assert.deepEqual(outputTokens({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 7 } } }),
    { partial: 7 });
  assert.deepEqual(outputTokens({ type: "result", usage: { output_tokens: 42 } }),
    { final: 42 });
  assert.equal(outputTokens({ type: "assistant", message: {} }), null);
  assert.equal(outputTokens({ type: "user" }), null);
});
