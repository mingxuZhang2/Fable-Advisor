import { test } from "node:test";
import assert from "node:assert/strict";
import { systemPromptFor, MODE_NAMES } from "../lib/modes.js";

test("six modes exist", () => {
  assert.deepEqual([...MODE_NAMES].sort(),
    ["advise", "audit", "discuss", "project_review", "research", "review"]);
});

test("each mode prompt is distinct and carries common rules", () => {
  const prompts = MODE_NAMES.map(systemPromptFor);
  assert.equal(new Set(prompts).size, MODE_NAMES.length);
  for (const p of prompts) {
    assert.match(p, /file:line/);
    assert.match(p, /same language/i);
  }
});

test("unknown mode falls back to advise", () => {
  assert.equal(systemPromptFor("nope"), systemPromptFor("advise"));
});
