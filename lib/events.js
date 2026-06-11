function toolTarget(input = {}) {
  return input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? "";
}

// 提取输出 token 计数:assistant 完整消息 → {completed};流式增量 → {partial};终态 → {final}
export function outputTokens(evt) {
  if (evt?.type === "assistant") {
    const n = evt.message?.usage?.output_tokens;
    return Number.isFinite(n) ? { completed: n } : null;
  }
  if (evt?.type === "stream_event") {
    const n = evt.event?.usage?.output_tokens;
    return Number.isFinite(n) ? { partial: n } : null;
  }
  if (evt?.type === "result") {
    const n = evt.usage?.output_tokens;
    return Number.isFinite(n) ? { final: n } : null;
  }
  return null;
}

// 一行 stream-json 事件 → 渲染项列表：{action} 进度行 | {text} 正文 | {done,event} 终态
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
  if (evt?.type === "result") return [{ done: true, event: evt }];
  return [];
}
