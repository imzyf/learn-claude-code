# s15: Integrated Harness 手动验证清单

本章不引入独立机制，只做集成：前面各章的工具、hook、权限、todo、subagent、技能、压缩、记忆、任务图、后台 bash、cron、团队、worktree、MCP 全部挂在同一个 `agentLoop` 上，共享一个 `messages[]`、一份每轮重算的工具池和一个事件队列；本章自己新增的只有错误恢复那一层（429 / 529 退避、fallback model、`max_tokens` 升配额与续写、prompt 超长触发 reactive compact）。

## 起跑

```sh
# 必须在仓库根目录跑：工具、worktree 校验和 .memory 都以 process.cwd() 为根
pnpm dev s15_integrated_harness/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s15_integrated_harness/.log -name '*_transcript.log' | sort | tail -1)"
```

跨轮状态留在磁盘上，开跑前先清干净，需要重来时也是这一条：

```sh
rm -rf s15_integrated_harness/.tasks s15_integrated_harness/.mailboxes \
       s15_integrated_harness/.transcripts s15_integrated_harness/.task_outputs \
       s15_integrated_harness/.scheduled_tasks.json .tmp/s15-check
git worktree list   # 除仓库根外不该有 s15_integrated_harness/.worktrees/ 下的条目
```

后面多次要取本次运行的日志，先在校验终端里存两个变量：

```sh
T=$(find s15_integrated_harness/.log -name '*_transcript.log' | sort | tail -1)
A=$(find s15_integrated_harness/.log -name '*_api.json' | sort | tail -1)
```

## 1. 启动即写 CONFIG 与两份 HOOK REGISTER

还没输入任何问题时，工具池就该是 26 个：

```sh
jq -s '[.[] | select(.config)][0].config.tools | map(.name) | length' "$A"   # 期望 26
jq -s '[.[] | select(.config)][0].config.tools | map(.name)' "$A" | grep -c update_task   # 期望 1
```

`update_task` 在不在是这一节的重点：任务图两阶段构建（第 3 节）全靠它，少一个工具模型就只能建孤立节点。

transcript 里 `HOOK REGISTER` 会出现两次，内容一样：

```plaintext
UserPromptSubmit: contextInjectHook
PreToolUse:       permissionHook, mcpPermissionHook, logHook
PostToolUse:      largeOutputHook
Stop:             summaryHook
```

两份是有意的：前台用户轮用注入了真实终端确认的那套 hook，异步轮用 `denyInteractive` 的那套（第 7 节）。两套的 hook 列表相同，差别只在 `permissionHook` 和 `mcpPermissionHook` 拿到的 `Confirm` 是谁。

## 2. system prompt 每轮重建，只在变化时写一节

- `Read README.md and tell me what this repo is.`
  读 `README.md`，告诉我这个仓库是干什么的。

transcript 的第一节 `SYSTEM PROMPT` 应该包含固定段加上每轮变的部分：

```plaintext
Available tools: bash, read_file, write_file, edit_file, glob, todo_write, task, load_skill, compact, create_task, update_task, ...
Create all task nodes first. Only after create_task returns runtime-generated IDs, use update_task with those exact IDs to add dependencies. Only the Lead changes task dependencies.
Working directory: /Users/.../learn-claude-code
Current time: 2026-08-25T...
Skills catalog:
- ...
```

同一次对话里连着问第二个问题，`SYSTEM PROMPT` 不应该每轮都重写一节：

```sh
grep -c 'SYSTEM PROMPT' "$T"
```

计数只在 system prompt 真的变了的时候加一（`lastSystem` 比对）。`Current time` 到秒，跨秒的两轮之间它一定不同，所以这个计数实际会随轮次增长；判据是每一节的内容都能对上当时的状态，而不是节数。要看清「只在变化时重写」，把注意力放在 `Memory catalog` 和 `Connected MCP servers` 这两段上：它们出现的那一节，前后一定夹着一次 `load_skill` 之外的状态变化（存了记忆、连了 server）。

## 3. 任务图两阶段构建

- `Plan a two-step change under .tmp/s15-check as tasks: first extract an auth module, then refactor the login page which depends on it. Create the tasks only, do not start the work.`
  在 `.tmp/s15-check` 下把一次两步改动拆成任务：先抽出认证模块，再重构依赖它的登录页。只建任务，不要开始干活。

期望先两次 `create_task`，拿到运行时 ID 之后才 `update_task`：

```plaintext
  [create] extract auth module
  [create] refactor login page
  [update] refactor login page blockedBy: task_xxxxxxxx
```

判据是顺序，不是次数：

```sh
grep -n 'TOOL RESULT (create_task)\|TOOL RESULT (update_task)' "$T"
```

`update_task` 的行号必须在两条 `create_task` 之后。模型自己编 ID 撞的是另外几条：编一个格式合法但不存在的 `task_00000001` 当依赖传进去得到 `Error: Dependency not found: task_00000001`，格式都不对（比如 `task_1`）得到 `Error: Invalid task ID: task_1`。这是这一节的反面判据：ID 由运行时给，不是模型猜的。

依赖真的进了任务板就再问一句 `List all tasks.`，被挡住的那条带 `blockedBy`，直接让它认领会被拒：

```plaintext
Blocked by: [task_xxxxxxxx]
```

## 4. connect_mcp 下一轮才生效

- `Search the docs for "agent loop" using an MCP tool.`
  用 MCP 工具搜索文档里的 "agent loop"。

这一轮模型只有内置工具，预期它先调 `connect_mcp({"name":"docs"})`，终端出灰字（这一行走 `print`，只打终端，不进 transcript）：

```plaintext
  [mcp] connected: docs -> search, get_version
```

同一轮里它调不到 `mcp__docs__search`：工具池在这次请求发出之前就组装好了。

- `Now actually search for "agent loop".`
  现在真的搜一下 "agent loop"。

这一轮的 `SYSTEM PROMPT` 一节多出一行，且 `ASSISTANT` 一节里出现调用：

```plaintext
Connected MCP servers: docs
[tool_use] mcp__docs__search: {"query":"agent loop"}
```

结果是 `[docs] Found 3 results for 'agent loop'`，不弹 `Allow? [y/N]`：`MCP_HOST_POLICY` 里 `docs/search` 是 `allow`。换 `deploy` server 的 `trigger` 才会停下来问，那条策略和 server 自己的 `annotations` 无关，细节在 s14 的清单里。

## 5. 后台 bash：占位结果加下一轮注入

- `Run "sleep 15 && echo integrated" in the background with run_in_background, and while it runs, read package.json.`
  用 `run_in_background` 在后台跑 `sleep 15 && echo integrated`，跑的时候顺便读 `package.json`。

期望黄字，并且循环不等这 15 秒，`read_file` 紧接着就执行：

```plaintext
  [background] started bg_0001: sleep 15 && echo integrated
```

占位 `tool_result` 的正文只在 `_api.json` 里：

```sh
grep -A2 'Background task' "$A"
```

```plaintext
[Background task bg_0001 started] The result will be collected on a later turn.
```

命令跑完后不需要你再输入任何东西：250ms 轮询发现有跑完的任务就推一个 wake 事件，新一轮开局注入通知。期望蓝字两行加一段 `<task_notification>`：

```plaintext
  [background] collected bg_0001: completed
  [inject] 1 background notification(s)
```

```sh
grep -A6 'task_notification' "$A" | head -20
```

`<status>` 是 `completed`、`<summary>` 里有 `integrated` 就对。后台命令固定跑在仓库目录，worktree 绑定只改前台工具的 cwd，所以这里的 `pwd` 永远是仓库根。

## 6. cron：注入本轮，模型接收后才销账

- `Schedule a one-shot, non-durable cron job for the next minute whose prompt is: write .tmp/s15-check/cron.txt containing the single line "fired".`
  安排一个下一分钟触发的一次性、非持久 cron 任务，prompt 是：写 `.tmp/s15-check/cron.txt`，内容只有一行 `fired`。

期望紫字，`cron_` 后面是随机 ID：

```plaintext
  [cron register] cron_1a2b3c4d '38 * * * *' -> write .tmp/s15-check/cron.txt
```

表达式不是 5 段会被挡在 croner 之前，`tool_result` 是 `Error: Expected 5 fields, got 6`。到点后调度器把任务推进队列，队列非空触发 wake，新一轮开局注入：

```plaintext
  [cron push queue] cron_1a2b3c4d -> write .tmp/s15-check/cron.txt
  [inject cron] write .tmp/s15-check/cron.txt
```

注入的消息形如 `[Scheduled] write .tmp/s15-check/cron.txt`，同时这句话会并进本轮的 `activeRequest`，压缩时它和用户原话一起进权威请求段（第 8 节）。模型接收之后一次性任务才销账，判据是问一句 `List all crons.`，那条任务应该已经不在了；`durable: true` 的任务再看磁盘：

```sh
cat s15_integrated_harness/.scheduled_tasks.json
```

至少一次交付的另一半（模型调用失败就把任务放回队列、撤回注入的 `[Scheduled]` 消息）从 REPL 里造不出来，由 `main.test.ts` 的「模型调用失败时撤回注入的 cron 消息并把任务放回队列」覆盖。

## 7. 四个唤醒源一个队列，异步轮不抢终端

用户输入、cron 队列、Lead 收件箱、跑完的后台任务，四种事件推进同一个队列，主循环单点消费。要看清这一点，就在一轮还没跑完的时候制造事件：趁上一节的后台 `sleep` 还在跑，立刻敲一行新问题回车。期望新问题排队等前一轮结束，不打断当前的工具调用，transcript 里两轮的 `REQUEST` 是串行的。

异步轮不能占用主终端问 y/N。造一次：

- `Schedule a one-shot cron job for the next minute whose prompt is: use bash to run "rm -f .tmp/s15-check/cron.txt".`
  安排一个下一分钟触发的一次性 cron 任务，prompt 是：用 bash 跑 `rm -f .tmp/s15-check/cron.txt`。

到点后这一轮由 wake 驱动，走的是 `asyncHooks`。期望黄字，且终端上不出现 `Allow? [y/N]`：

```plaintext
  [permission] async turn cannot ask: Potentially destructive command (bash)
```

模型拿到的 `tool_result` 是 `Permission denied by user`。对照组是你自己在前台问同一件事，那一轮走 `hooks`，应该停下来问：

```plaintext
[permission] Potentially destructive command
   Tool: bash({"command":"rm -f .tmp/s15-check/cron.txt"})
   Allow? [y/N]
```

命中的是 s03 的规则 2（bash 命令含 `rm`），不是拒绝名单。这里和 `upstream.README.zh.md` 的说法有出入：README 描述的是 `code.py`，那边每条 bash 都问；TS 版复用 s03 的三关，只有命中关键字的 bash 才问，拒绝名单（`sudo`、`shutdown`、`mkfs` 等）直接拦，不问。

Lead 收件箱那一路用团队场景验：spawn 一个队友，队友说完一轮话会发 `result` 和 `idle_notification`，主循环消费收件箱后起新一轮，期望黄字 `[team auto] 2 event(s)`。队友、计划闸门、worktree 的完整验证在 s13 的清单里，这里只确认事件确实回流成新一轮。

## 8. 压缩排在工具批次末尾

- `Compact the conversation now.`
  现在把对话压缩掉。

模型调 `compact` 时循环不走 dispatch，直接回一条 `tool_result`：

```plaintext
[Compaction requested. This completed turn will be summarized.]
```

整批工具跑完、结果入 `messages[]` 之后才压缩，所以同一批里排在 `compact` 之前的工具输出会进摘要，不会白跑。压缩后历史只剩一条 `[Compacted]` 消息，判据是它同时带着权威请求段和摘要段：

```sh
grep -A4 'Compacted' "$A" | head -20
```

```plaintext
[Compacted]\n\nCurrent user request:\n...\n\nConversation summary (reference only):\n...
```

`compact` 的 `tool_use` 和它的 `tool_result` 一起被摘要吸收，不会留下孤立引用。判据是压缩之后那次请求：`_api.json` 里最后一条 `api_request` 的 messages 只有 `[Compacted]` 那一条加上后续消息，整段不含 `tool_use_id`。

```sh
jq -s '[.[] | select(.tag == "api_request")] | last | .messages | tostring | contains("tool_use_id")' "$A"   # 期望 false
```

自动压缩那几层（L1 裁剪、L2 微压缩、L3 落盘、L3b fit、L4 摘要）阈值都可以在命令行内联调小，一次运行就能看到：

```sh
L4_COMPACT_CONTEXT_LIMIT=8000 L1_COMPACT_SNIP_MAX_MESSAGES=8 pnpm dev s15_integrated_harness/main.ts
```

跑几轮读文件的问题，期望依次出现 `[COMPACT L1] snip compact: N messages removed (... → ... chars)`、`[COMPACT L4] auto compact` 这样的黄字，存档落在 `s15_integrated_harness/.transcripts/`。各层自身的判据在 s08 的清单里，这里只确认它们在 s15 的循环里被调用，且排在模型调用之前。

## 9. 错误恢复：能造的和造不出来的

本章唯一的新机制，四条路能造出来的只有一条半。

`max_tokens` 那条能造：让模型写一段很长的输出。

- `Write a 3000-word essay about the agent loop. Do not stop early.`
  写一篇 3000 词的 agent loop 长文，不要提前收尾。

期望黄字，之后模型接着写完：

```plaintext
  [max_tokens] retry with 16000
```

升到 16000 还截断的话，会追加一条 `Continue from the previous response. Do not repeat completed work.` 要求续写，最多两次（`MAX_RECOVERY_RETRIES`）。这一步靠模型真的写满配额，写不满就撞不出来，不算运行时有问题。

fallback model 那条能半造：设一个存在的备用模型，再让主模型报 529。529 按需触发不了，但可以先确认配置读到了（默认值和写死的那几个上限见 `defaults.env`，一份参考清单，程序不加载它）：

```sh
FALLBACK_MODEL_ID=glm-4.5 pnpm dev s15_integrated_harness/main.ts
```

真撞上连续两次 529 时的输出是 `[529] switching to glm-4.5`，之后这一轮用备用模型重试。429 同理，只有被真限流时才出现 `[429] retry 1/3 after 0.5s`。这两条和 prompt 超长触发 reactive compact 都由 `main.test.ts` 的「错误恢复」和「prompt 超长触发一次 reactive compact 后重试」覆盖，手工验证只确认真撞上时的输出格式对得上。

其他错误不重试，直接收尾：把 `.env` 里的 `MODEL_ID` 改成一个不存在的模型名再启动，随便问一句，期望一轮就结束并打出 `[Error] ...`，transcript 里对应的是一节 `ERROR <trace_id> <ms>ms`，正文是错误名、HTTP 状态和原文。

## 10. 记忆跨会话

跑完前面几节之后退出，看仓库根的 `.memory/`：

```sh
ls .memory/
cat .memory/MEMORY.md
```

有新记录时终端上会有黄字 `[Memory] stored N records: ...`，记录多了还会跟一条 `[Memory] consolidated N -> M records`。重启进程再问一句和之前话题相关的问题，期望：

```plaintext
[Memory] select relevant by LLM: xxx.md
```

并且这一轮的 `SYSTEM PROMPT` 一节里出现 `Memory catalog:` 和 `Relevant memory records:` 两段。模型调用失败时会退回关键词匹配（`[Memory] LLM select failed, fallback to keyword match ...`），记忆层不阻塞主循环，这一条不用专门造。

召回是背景信息，不是命令：system prompt 里有一段明说了当前用户请求优先。要试探这一点，先存一条明确的偏好记忆，再发一个和它冲突的请求，期望模型照当前请求做。

## 11. 提示符与退出

整个过程里提示符 `s15 >>` 始终在最下面一行：`[background]`、`[inject cron]`、`[team auto]`、`[HOOK]` 的输出都从它上方流过，输入到一半的字不会被吃掉。

让它在后台跑 `sleep 300`，再注册一个 recurring cron，然后直接输入 `q`。期望进程立刻退回 shell，不是卡在那里等 300 秒：cron 的 1s 定时器和 250ms 轮询都调了 `unref()`，还在跑的后台命令由退出前的 `stopBackgroundProcesses()` 连同进程组一起停掉。另一个终端确认没留下孤儿进程：

```sh
pgrep -f "sleep 300"   # 期望没有输出
```

`Ctrl+D` 走 `rl` 的 close 事件，推一个 quit 事件，走同一条退出路径；`Ctrl+C` 是 `process.exit(0)`，进程组清理挂在 `process.on("exit")` 上，同样不留孤儿。

这样退出不会等后台命令跑完，它的结果也就不会再回到任何一段对话。`durable: true` 的 cron 任务留在 `.scheduled_tasks.json` 里，下次启动时 `loadDurableJobs` 会打一行 `[cron] loaded N durable job(s)`，上次退出时还挂着 `pendingDelivery` 的任务重新进队列，重启后立刻触发一轮。这是至少一次交付的代价，不是 bug。

留着 `in_progress` 任务的队友直接退出时，任务会带着 owner 留在 `.tasks/` 里，下次启动没人能完成它，清任务板见下一节。
