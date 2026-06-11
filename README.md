# fable-advisor

把第三方中转(anyrouter)的 Fable 模型封装成 Claude Code 的 MCP advisor:
主会话该用什么模型用什么模型,需要审查 / 审计 / 辩论 / 二次意见时才咨询 Fable,
对代码**严格只读**。v2 支持命名对话持久续聊、实时进度、后台运行。

## 原理

```
主 Claude Code 会话(订阅/任意模型,经 wrapper 代理)
   │  MCP 工具:consult_fable / fable_status / fable_result / ...
   ▼
server.js(stdio MCP server,薄壳:写 spec → spawn → 轮询状态文件)
   │  spawn detached(自成进程组,server 死了它照跑)
   ▼
runner.js ── claude -p --output-format stream-json [--resume <sid>]
   │            --setting-sources "" --allowedTools Read Grep Glob WebFetch WebSearch
   │            env: ANTHROPIC_BASE_URL/AUTH_TOKEN = 中转凭据
   ├─ 逐事件写 ~/.fable-advisor/runs/<id>/live.md + state.json
   └─ 结束写 result.json,session_id 回存 conversations.json
```

所有状态都在磁盘(`~/.fable-advisor/`):MCP server、主会话随便重启,
在跑的任务不受影响,跨会话可查可续。

## 5 个工具

| 工具 | 作用 |
|---|---|
| `consult_fable` | 主入口:发起一次咨询(阻塞或后台) |
| `fable_status` | 查 run 进度:状态、当前动作、耗时、最近输出(默认最近一个 run) |
| `fable_result` | 取最终回答(+成本/耗时/对话元信息);没跑完则返回当前进度 |
| `fable_conversations` | 列出/删除命名对话(按项目目录) |
| `fable_cancel` | 取消在跑的 run(杀整个进程组,live.md 保留部分转录) |

### consult_fable 参数

| 参数 | 类型/默认 | 说明 |
|---|---|---|
| `prompt` | string,必填 | 咨询/审查/讨论内容(自包含,Fable 自己读代码) |
| `directory` | string,必填 | 项目绝对路径(子进程 cwd,Fable 的可读范围) |
| `mode` | 枚举,默认 `advise` | 见下方 5 种模式 |
| `conversation` | string,默认 `"default"` | 命名对话,同名续聊(`--resume`) |
| `fresh` | bool,默认 false | 丢弃该名字的历史,重新开始 |
| `files` | string[],可选 | 重点文件/子目录(相对 directory) |
| `background` | bool,默认 false | true:立即返回 run_id,不阻塞 |

## 5 种模式

| mode | 角色 |
|---|---|
| `review` | 代码审查:实现正确性——bug、边界条件、逻辑错误;按严重度分级,带 file:line |
| `project_review` | 宏观审稿:架构、模块划分、方法论、技术债、方向性风险;不纠缠单行代码 |
| `audit` | 对抗审计:安全/数据正确性/质量清单式排查,苛刻、宁可误报 |
| `discuss` | 辩论伙伴:立场鲜明、敢直接反驳、不附和,观点给依据 |
| `advise` | 顾问:列出选项 + 权衡,给一个明确推荐 |

公共约束:回复语言跟随提问;引用代码必须 file:line。

## 命名对话

- 同名 `conversation` 再次调用 → Fable **记得之前聊过的内容**(底层 `--resume` session)。
- `fresh=true` → 丢掉该名字的历史重新开始;换个名字 → 平行的新线程。
- `fable_conversations` 列出所有线程(名字、mode、轮数、最后使用、话题摘要),
  `action=delete` + `directory` + `name` 删除。
- 对话注册表在 `~/.fable-advisor/conversations.json`,按项目目录隔离,**跨主会话持久**。

## 实时进度与后台运行

**阻塞模式**(默认):等待期间通过 MCP progress notification 实时推送状态行
(`step 3 · Read src/train.py · 52s`),完成直接返回最终回答。
按 **Esc 中断等待后 run 继续在后台跑**,随后用 `fable_status` / `fable_result` 取。

**后台模式**(`background=true`):立即返回 `run_id`,然后:

```bash
tail -f ~/.fable-advisor/runs/<run_id>/live.md   # 全文直播(回答 + 工具动作)
```

进度用 `fable_status` 查,完事用 `fable_result` 取终稿。大任务(整库 audit)建议后台跑。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `FABLE_BASE_URL` | **必填** | 中转地址,如 `https://anyrouter.top` |
| `FABLE_AUTH_TOKEN` | **必填** | 中转的 sk-... token |
| `FABLE_MODEL` | `claude-fable-5[1m]` | 子进程用的模型 |
| `FABLE_CLAUDE_BIN` | `claude` | claude 不在 PATH 时给真实二进制绝对路径 |
| `FABLE_HOME` | `~/.fable-advisor` | 状态目录(runs/ + conversations.json) |
| `FABLE_STALL_MINUTES` | `10` | 活性看门狗:**没有硬超时**,只看是否还有 stream 事件;连续 N 分钟无任何事件才判挂死 |
| `FABLE_RETRY_DELAYS_MS` | `5000,15000,30000` | 限流重试退避序列 |

## 部署(目标机器)

前提:Node ≥22 + Claude Code CLI。

```bash
# 把 fable-advisor/ 整目录拷到目标机器(连 node_modules 一起拷可跳过 npm install)
cd ~/fable-advisor && npm install

claude mcp add -s user fable-advisor \
  -e FABLE_BASE_URL=https://anyrouter.top \
  -e FABLE_AUTH_TOKEN=sk-你的token \
  -e FABLE_CLAUDE_BIN=/真实claude二进制的绝对路径 \
  -- node ~/fable-advisor/server.js

claude mcp list   # 应显示 fable-advisor ✓ connected
```

关键点:

- 子进程继承主会话 wrapper 导出的 `HTTPS_PROXY`,中转流量自动走代理(复用在跑的 mihomo)。
- `--setting-sources ""`:子进程**不加载** `~/.claude/settings.json`,中转凭据隔离在
  MCP env 里,主会话不受影响;也不继承 `bypassPermissions`。
- 严格只读:`--allowedTools Read Grep Glob WebFetch WebSearch`,
  并显式 disallow Bash/Edit/Write。
- **v1 → v2 是 drop-in 升级**:覆盖目录即可,注册命令、env、路径全不变,
  `/mcp` reconnect 或重开会话生效,无需重新注册。

## 使用示例

在主 Claude Code 会话里说自然语言即可:

> 用 consult_fable 以 review 模式审一下我刚改的 src/runner.py,重点看边界条件

> 用 consult_fable 对整个项目做 background audit,然后给我 tail 命令我自己看直播

> 在 "rl-design" 这个 conversation 里继续和 Fable 辩论:它上次说的第二点我不同意,因为…

> 用 fable_conversations 列一下这个项目有哪些和 Fable 的对话

## 故障排查

- **429 / overloaded**:runner 自动重试 3 次(5s/15s/30s 退避),状态行可见重试进度;
  仍失败说明中转限流严重,稍后再试。
- **stalled: no events for N min**:活性看门狗判定挂死(连续 N 分钟无任何 stream 事件),
  杀进程组标 failed;live.md 里已有的内容是部分结果。慢但还在动的任务不会被杀。
- **孤儿 run**:state.json 超 60s 没更新且 runner 进程已死 → `fable_status` 自动改判 failed。
- **resume 失效**(中转清理了 session):自动降级新开对话继续跑,live.md 中注明。
- `claude mcp list` 显示连接失败:手动 `node ~/fable-advisor/server.js` 看报错
  (缺 env 时直接打印 `FABLE_BASE_URL and FABLE_AUTH_TOKEN must be set`)。
- 跑测试:仓库目录里 `npm test`(即 `node --test "tests/*.test.js"`)。
