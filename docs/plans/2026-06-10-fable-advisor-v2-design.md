# fable-advisor v2 设计文档

日期:2026-06-10
状态:设计已获用户确认

## 背景与目标

v1(已部署 hpc2/3090)把第三方中转(anyrouter)的 Fable 模型封装成 MCP 工具
`consult_fable`,内部 spawn headless Claude Code(`claude -p`),代码只读。
v1 的局限:无状态(每次全新对话)、一次性 JSON 返回(无进度)、单一用途。

v2 目标:把它升级成一个完整的 advisor——可咨询、可持续讨论/辩论、可代码审查、
可宏观审稿、可审计;阻塞调用时状态行实时显示 Fable 正在干什么;支持后台运行
(Claude Code 尚不支持 MCP 工具 Ctrl+B 转后台,见 anthropics/claude-code#18617,
故在 server 层自实现);支持命名对话的持久续聊。

## 架构

文件状态机(用户选定方案 B):所有运行状态落盘 `~/.fable-advisor/`,
后台 run 用 detached runner 进程,不依赖 MCP server 存活;
MCP server 重启、主会话重启都不影响在跑的任务,跨会话可查。

```
主 Claude Code 会话(订阅,经 wrapper/mihomo 代理)
   │ MCP tools
   ▼
fable-advisor server.js(stdio MCP server)
   │ spawn(后台时 detached)
   ▼
runner.js ── claude -p --output-format stream-json [--resume <sid>]
   │             env: ANTHROPIC_BASE_URL/AUTH_TOKEN(anyrouter)
   │             代理:继承主会话的 HTTPS_PROXY(wrapper 已导出)
   ├─ 逐事件写 runs/<id>/live.md + state.json
   └─ 结束写 result.json,回存 session_id → conversations.json
```

## MCP 工具(5 个)

### consult_fable(主入口)
| 参数 | 类型/默认 | 说明 |
|---|---|---|
| prompt | string,必填 | 咨询/审查/讨论内容 |
| directory | string,必填 | 项目绝对路径(子进程 cwd) |
| mode | 枚举,默认 advise | 见下方 5 种模式 |
| conversation | string,默认 "default" | 命名对话,同名续聊(--resume) |
| fresh | bool,默认 false | 丢弃该名字历史,重新开始 |
| files | string[],可选 | 重点文件 |
| background | bool,默认 false | true:立即返回 run_id + tail 命令 |

阻塞模式:MCP progress notification 实时推送状态行
(`turn 3 · 正在读 src/train.py · 1.8k tok · 52s`),完成返回最终回答。
后台模式:立即返回 `{run_id, live_path, tail 命令提示}`。

### fable_status(run_id 可选,默认最近)
状态(running/done/failed/cancelled)、当前轮次与动作、耗时、tokens、
最近几行输出。

### fable_result(run_id 可选)
完成则返回最终回答(+cost/duration/conversation 元信息);
未完成返回当前进度与部分内容提示。

### fable_conversations(directory 可选,action: list|delete)
列出命名对话:名字、mode、轮数、最后使用、话题摘要。

### fable_cancel(run_id)
杀整个进程组,状态标 cancelled,live.md 保留。

## 5 种模式(--append-system-prompt 预设)

- **review** 代码审查:实现正确性——bug、边界条件、逻辑错误、与意图不符;
  输出按严重度分级 findings,必须带 file:line
- **project_review** 宏观审稿:架构、模块划分、方法论/实验设计、技术债、
  方向性风险;不纠缠单行代码
- **audit** 审计:安全/数据正确性/质量清单式对抗排查,苛刻、宁可误报
- **discuss** 辩论伙伴:立场鲜明、敢直接反驳、不附和,观点给依据
- **advise** 顾问:选项 + 权衡 + 明确推荐

公共约束:回复语言跟随提问;引用代码必须 file:line。

## 磁盘布局

```
~/.fable-advisor/
  conversations.json      # "<目录>::<对话名>" → {session_id, mode, turns,
                          #   last_used, summary}
  runs/<run_id>/          # run_id: <时间戳>-<mode>-<rand4>
    state.json            # {status, pid, pgid, turn, action, started,
                          #   updated, conversation, directory, mode}
    live.md               # 全文实时转录(assistant 文本 + 工具动作行)
    result.json           # 最终回答 + cost/usage/session_id
    prompt.txt
```

## 子进程权限与网络

- `--allowedTools Read Grep Glob WebFetch WebSearch`(代码只读 + 可联网;
  WebSearch 为 API 侧能力,取决于中转支持,不支持不影响其他功能)
- `--setting-sources ""`:不读目标机 settings.json,不跑用户 hooks,
  不继承 bypassPermissions
- 代理:继承主会话 wrapper 导出的 HTTPS_PROXY(复用在跑的 mihomo)
- token 只存于 MCP 注册 env(~/.claude.json),runner 进程继承,不落盘

## 错误处理

- **无硬超时**(用户明确要求):只看活性。连续 FABLE_STALL_MINUTES
  (默认 10 分钟)无任何 stream 事件 → 判定挂死,杀进程组,标 failed,
  live.md 已有内容作为部分结果
- 429/限流:runner 内重试 3 次(5s/15s/30s),状态行显示重试进度
- 孤儿检测:fable_status 发现 state.json 超 60s 未更新且 pid 已死 → 标 failed
- resume 失效(中转清理了 session):自动降级新开对话,结果中注明
- 阻塞模式长任务:progress notification 持续推送可防客户端超时;
  超长任务建议 background=true

## 测试方案

1. 协议冒烟:initialize / tools/list,5 工具 schema 正确
2. 阻塞 e2e(真实 anyrouter):进度通知序列 + 最终结果
3. 命名对话:同名第二次调用能引用第一次内容;fresh 后引用不到
4. 后台 e2e:立即返回 → status 见 turn 推进 → result 取终稿;
   中途杀 MCP server,重启后 status/result 仍工作
5. 取消:cancel 后进程组确实死亡
6. 服务器:两台各跑 CHAIN-OK + 一次真实小 review

## 部署

drop-in:覆盖两台服务器 `~/fable-advisor/`(server.js + 新增 runner.js),
注册命令、env、路径全部不变,`/mcp` reconnect 或重开会话生效。
