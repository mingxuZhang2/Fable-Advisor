#!/usr/bin/env node
/**
 * fable-advisor — MCP stdio server.
 *
 * Exposes one tool: consult_fable(prompt, directory, files?).
 * Internally spawns headless Claude Code (`claude -p`) pointed at a
 * third-party Anthropic-compatible endpoint, pinned to the Fable model,
 * with read-only tools (Read/Grep/Glob). The main Claude Code session
 * keeps its own auth/model; only this tool's traffic goes to the relay.
 *
 * Required env (set via `claude mcp add -e ...`):
 *   FABLE_BASE_URL    e.g. https://anyrouter.top
 *   FABLE_AUTH_TOKEN  the relay's sk-... token
 * Optional env:
 *   FABLE_MODEL       default: claude-fable-5[1m]
 *   FABLE_CLAUDE_BIN  default: claude (must be on PATH)
 *   FABLE_TIMEOUT_MS  per-call timeout, default 900000 (15 min)
 */

import { execFile } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.FABLE_BASE_URL;
const AUTH_TOKEN = process.env.FABLE_AUTH_TOKEN;
const MODEL = process.env.FABLE_MODEL || "claude-fable-5[1m]";
const CLAUDE_BIN = process.env.FABLE_CLAUDE_BIN || "claude";
const TIMEOUT_MS = Number(process.env.FABLE_TIMEOUT_MS || 900000);

if (!BASE_URL || !AUTH_TOKEN) {
  console.error("fable-advisor: FABLE_BASE_URL and FABLE_AUTH_TOKEN must be set");
  process.exit(1);
}

const RETRYABLE = /429|rate.?limit|overloaded|service unavailable|529|ECONNRESET|ETIMEDOUT/i;
const RETRY_DELAYS_MS = [5000, 15000, 30000];

function runClaude(prompt, directory) {
  const args = [
    "-p", prompt,
    "--model", MODEL,
    // Don't load user/project settings: keeps the relay env isolated and
    // ensures default (non-bypass) permissions, so non-allowed tools are denied.
    "--setting-sources", "",
    "--allowedTools", "Read", "Grep", "Glob",
    "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch",
    "--output-format", "json",
  ];

  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: AUTH_TOKEN,
    ANTHROPIC_MODEL: MODEL,
    API_TIMEOUT_MS: String(TIMEOUT_MS),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  // Make sure a key from the host session never leaks into the child.
  delete env.ANTHROPIC_API_KEY;

  return new Promise((resolve) => {
    execFile(
      CLAUDE_BIN,
      args,
      { cwd: directory, env, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout, stderr })
    );
  });
}

async function consultFable({ prompt, directory, files }) {
  let fullPrompt = prompt;
  if (files?.length) {
    fullPrompt += `\n\nFocus on these files/paths:\n${files.map((f) => `- ${f}`).join("\n")}`;
  }

  let lastFailure = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    }

    const { error, stdout, stderr } = await runClaude(fullPrompt, directory);

    if (!error) {
      try {
        const result = JSON.parse(stdout);
        if (!result.is_error) {
          return { content: [{ type: "text", text: result.result ?? "" }] };
        }
        lastFailure = result.result || JSON.stringify(result);
      } catch {
        // Non-JSON but exit 0 — return raw output rather than failing.
        return { content: [{ type: "text", text: stdout.trim() }] };
      }
    } else {
      lastFailure = `${error.message}\n${stderr}`.trim();
    }

    if (!RETRYABLE.test(lastFailure)) break;
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Fable advisor failed: ${lastFailure.slice(0, 2000)}` }],
  };
}

const server = new McpServer({ name: "fable-advisor", version: "1.0.0" });

server.registerTool(
  "consult_fable",
  {
    title: "Consult Fable",
    description:
      "Consult the Fable model (a stronger reviewer model on a separate endpoint) for code audit, " +
      "code review, architecture critique, security analysis, or a second opinion on any technical question. " +
      "The advisor has read-only access (Read/Grep/Glob) to the given directory — it can explore code itself, " +
      "so the prompt only needs to say what to review and which paths matter. " +
      "Expensive and possibly slow (minutes); use for substantive review/audit questions, not trivial lookups.",
    inputSchema: {
      prompt: z
        .string()
        .describe("What to review/audit/answer. Include acceptance criteria or concerns if any."),
      directory: z
        .string()
        .describe("Absolute path of the project directory the advisor may read."),
      files: z
        .array(z.string())
        .optional()
        .describe("Optional list of files or subdirectories (relative to directory) to focus on."),
    },
  },
  consultFable
);

await server.connect(new StdioServerTransport());
