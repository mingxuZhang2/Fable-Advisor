# fable-advisor

把第三方中转(anyrouter)的 Fable 模型封装成 Claude Code 的 MCP advisor:
主会话该用什么模型用什么模型,只有显式咨询(audit / review / 二次意见)时,
才通过 `consult_fable` 工具调用 headless Claude Code 走第三方端点,且对代码**只读**。

## 原理

```
主 Claude Code 会话(订阅/任意模型)
   │  调用 MCP 工具 consult_fable(prompt, directory)
   ▼
fable-advisor (本目录的 stdio MCP server, Node)
   │  spawn: claude -p "<prompt>" --model 'claude-fable-5[1m]'
   │         --setting-sources "" --allowedTools Read Grep Glob
   │  env:   ANTHROPIC_BASE_URL=https://anyrouter.top
   │         ANTHROPIC_AUTH_TOKEN=sk-...
   ▼
第三方端点上的 Fable,只读浏览代码后返回审查结论
```

关键点:
- 子进程用 `--setting-sources ""` **不加载** `~/.claude/settings.json`,
  所以中转凭据完全隔离在 MCP server 的环境变量里,主会话不受影响;
  子进程也不会继承 `bypassPermissions`,配合 allowedTools 只读。
- 对 429 / overloaded / Service Unavailable 自动重试(5s/15s/30s 退避)——
  anyrouter 的 fable 经常 429,这个必须有。

## 在目标机器上的部署步骤

前提:机器上已装 Node ≥18 和 Claude Code CLI(`claude` 在 PATH 上)。

### 1. 拷贝并安装依赖

```bash
# 把 fable-advisor/ 整个目录拷到目标机器,例如 ~/tools/fable-advisor
cd ~/tools/fable-advisor
npm install
```

### 2. 清理主会话的 settings.json

如果目标机器的 `~/.claude/settings.json` 里有把全部流量指向中转的 env
(`ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` /
`ANTHROPIC_DEFAULT_*_MODEL` 这些),**全部删掉**,让主会话回到订阅登录
(`claude /login`),之后 `/model` 想切什么切什么。

### 3. 注册 MCP server(user 作用域,所有项目可用)

```bash
claude mcp add -s user fable-advisor \
  -e FABLE_BASE_URL=https://anyrouter.top \
  -e FABLE_AUTH_TOKEN=sk-你的token \
  -- node ~/tools/fable-advisor/server.js
```

可选环境变量:`FABLE_MODEL`(默认 `claude-fable-5[1m]`)、
`FABLE_TIMEOUT_MS`(默认 15 分钟)、`FABLE_CLAUDE_BIN`(claude 不在 PATH 时给绝对路径)。

### 4. 验证

```bash
claude mcp list          # 应显示 fable-advisor ✓ connected
```

然后在任意项目里开 claude,说:

> 用 consult_fable 让 Fable review 一下 src/ 目录的代码质量

主模型会调用 `mcp__fable-advisor__consult_fable`,几分钟后返回 Fable 的审查结论。

### 5.(可选)让主模型主动用它

在常用项目的 `CLAUDE.md` 里加一句:

```markdown
- 完成较大改动后,用 consult_fable 工具请 Fable 做一次 code review,把结论汇总给我。
```

## 故障排查

- 工具报 `Fable advisor failed: ... 429`:重试 3 次仍失败,说明中转限流严重,稍后再试。
- `claude mcp list` 显示连接失败:`node ~/tools/fable-advisor/server.js` 手动跑一下看报错
  (缺 env 时会直接打印 `FABLE_BASE_URL and FABLE_AUTH_TOKEN must be set`)。
- 返回空结果:确认 `directory` 传的是绝对路径,且该路径下确实有代码。
