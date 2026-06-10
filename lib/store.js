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
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return fallback; // ENOENT 等读失败:静默回退
  }
  try {
    return JSON.parse(raw);
  } catch {
    // 文件存在但不是合法 JSON:挪到一边留证据,不覆盖
    const aside = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, aside); } catch {}
    console.error(`fable-advisor: corrupt JSON at ${file}, moved aside to ${aside}`);
    return fallback;
  }
}
// 写临时文件再 rename,读方永远不会看到半截 JSON
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10_000;

// 跨进程互斥:mkdir 是原子的,拿不到就重试;超过 10s 的锁视为残留(持有者已死)
function withConversationsLock(fn) {
  const lockDir = conversationsPath() + ".lock";
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let acquired = false;
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      break;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue; // 不计休眠,立刻重试抢锁
        }
      } catch {} // 锁刚好被释放/被别人清理:直接重试
      sleepSync(LOCK_RETRY_MS);
    }
  }
  if (!acquired) {
    throw new Error(
      `fable-advisor: could not acquire conversations lock at ${lockDir} after ${LOCK_RETRIES} attempts`
    );
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lockDir); } catch {}
  }
}

export function getConversation(directory, name) {
  return readJson(conversationsPath(), {})[directory]?.[name] ?? null;
}
export function setConversation(directory, name, data) {
  withConversationsLock(() => {
    const all = readJson(conversationsPath(), {});
    const dir = (all[directory] ??= {});
    dir[name] = { ...(dir[name] ?? {}), ...data };
    writeJson(conversationsPath(), all);
  });
}
export function deleteConversation(directory, name) {
  withConversationsLock(() => {
    const all = readJson(conversationsPath(), {});
    if (all[directory]) {
      delete all[directory][name];
      if (Object.keys(all[directory]).length === 0) delete all[directory];
    }
    writeJson(conversationsPath(), all);
  });
}
export function listConversations(directory = null) {
  const all = readJson(conversationsPath(), {});
  const out = [];
  for (const [dir, convs] of Object.entries(all)) {
    if (directory && dir !== directory) continue;
    for (const [name, data] of Object.entries(convs)) {
      out.push({ directory: dir, name, ...data });
    }
  }
  return out;
}

export function listRuns() {
  try {
    return fs.readdirSync(runsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{12}-/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
export function latestRunId() {
  const runs = listRuns();
  return runs.length ? runs[runs.length - 1] : null;
}
