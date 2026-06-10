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
