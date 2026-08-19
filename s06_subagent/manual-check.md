# s06: Subagent 手动验证清单

本章只加了一个机制：`task` 起一个 `messages[]` 全新的子循环，只把最终文本还给父 agent（`main.ts:115-197`）。这份清单围绕它验三件事：委派真的发生了、父上下文只拿到那段摘要、父子共用 hook 与 `WORKDIR` 的边界在哪。

`main.test.ts` 已用 fake client 覆盖 `spawnSubagent` 的返回值、轮次上限和 schema 校验，手动跑补的是 fake 替不掉的部分：真实模型愿不愿意委派、终端上父子两路输出如何交错、transcript 里 `[sub]` 标注与两套独立的增量计数。

工具分发、权限关卡、hook 机制在 [s02](../s02_tool_use/manual-check.md)、[s03](../s03_permission/manual-check.md)、[s04](../s04_hooks/manual-check.md)、[s05](../s05_todo_write/manual-check.md) 的清单里验过，s06 原样复用（`loadHooks`，`main.ts:280`），这里不重复。s05 的 `todo_write` 和唠叨提醒不在本章工具表里（`main.ts:81-89`）。

```sh
pnpm dev s06_subagent/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s06_subagent/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 启动即写 HOOK REGISTER，工具表是 6 个

还没输入任何问题时，transcript 里就该有一节 `HOOK REGISTER`，和 s05 逐条相同：

```plaintext
UserPromptSubmit: contextInjectHook
PreToolUse:       permissionHook, logHook
PostToolUse:      largeOutputHook
Stop:             summaryHook
```

同时 `.log/*_api.json` 的第一条是 `config`（`main.ts:278`），里面的 `tools` 应该是 6 个：s02 的 5 个基础工具加一个 `task`。子 agent 的工具表不在这里，它是模块内的 `subTools`（`main.ts:78`），日志里看不到，第 5 项用行为反推。

## 2. 一次委派：终端上父子两路输出

- `Use a subtask to find what testing framework this project uses`

期望顺序（颜色在括号里）：

1. `🔧 task({"prompt":"..."})`（青，父 agent 的 `printProse`）
2. `[Subagent started]`（品红，`main.ts:123`）
3. 子 agent 的每一轮：`[sub] 🔧 read_file({...})`（青）、`[sub] [read_file] ...`（灰，输出预览，`main.ts:184`）
4. `[HOOK] Stop(summaryHook): session used N tool calls`（灰）
5. `[Subagent done]`（品红）
6. `[HOOK] Stop(summaryHook): session used M tool calls`（灰）
7. 父 agent 的最终回答（绿）

两个观察点：

- 第 3 步的输出预览只有子 agent 有。父循环没有这一行（对比 `main.ts:258` 附近，父 agent 只走 `logger.toolResult`），所以终端上看得见的工具输出都来自子 agent。
- `[HOOK]` 开头的行**不带** `[sub]` 前缀，哪怕它记录的是子 agent 的工具调用。原因是 hook 实例持的是父 logger（`main.ts:280` 的 `loadHooks(logger)`），只有 `spawnSubagent` 自己派生了 `child("sub")`（`main.ts:121`）。前缀标的是「哪个 logger 写的」，不是「哪个 agent 干的」。

第 4 和第 6 步是同一个 `summaryHook`、不同的 `messages`：子循环退出前也跑 Stop hook（`main.ts:142`），此时数的是子 agent 自己那份 `messages` 里的 `tool_result`；父 agent 那条数的是整个 `history`（`../s04_hooks/main.ts:232-249`）。所以一轮里出现两条 Stop 行是正常的，N 通常小于 M。

## 3. 上下文隔离的证据在 transcript

接着上一步看 transcript，一次 `task` 应该留下这样一串：

```plaintext
── ASSISTANT ab12cd ...            父 agent 决定调 task
── [sub] REQUEST ef34ab ...        子 agent 第 1 轮
── [sub] ASSISTANT ef34ab ...
── [sub] TOOL RESULT (read_file) ...
── [sub] REQUEST ...               子 agent 第 2 轮
...
── TOOL RESULT (task)              只有子 agent 的最后一段文本
```

`TOOL RESULT (task)` 那一节是判定隔离的关键：正文应该是一段结论（比如「vitest」），**不含**子 agent 读过的文件内容。子 agent 读了多少东西，只会写进带 `[sub]` 的那些节。

再看紧随其后的父 `REQUEST`：计数是 `N messages (2 new)`，新增的两条是 assistant 的 `tool_use` 和 user 的 `tool_result`，`chars` 不会因为子 agent 读了几万字符的文件而暴涨。想直接看请求体，在 `.log/*_api.json` 里对照：带 `"scope": "sub"` 的 `api_request` 有子 agent 的完整消息，父 agent 的 `api_request` 里一条都没有。

## 4. 每次 task 都是一个新 scope

- `Use two separate subtasks: one to count the .ts files in lib/, another to read the name field in package.json.`

`spawnSubagent` 每次调用都新建 `deps.logger.child("sub")`（`main.ts:121`），而增量计数 `loggedMessages` 是每个 scope 各自维护的（`../lib/logger.ts:64-72`）。所以第二个子 agent 的第一节应该重新从 `[sub] REQUEST ... 1 messages (1 new)` 开始，而不是接着第一个的计数往上加。

终端上 `[Subagent started]` / `[Subagent done]` 必须成对且不嵌套：`task` 是同步 `await` 的（`main.ts:253`），第一个子 agent 结束后第二个才开始。如果看到两个 `started` 连着出现，说明父循环把两个 `tool_use` block 并发跑了。

## 5. 子 agent 不能再委派

- `Use a task; inside that task, tell the subagent to delegate again with another task.`

`subTools` 是 `[...s02Tools]`（`main.ts:78`），没有 `task`，模型压根收不到这个工具声明，所以全程只有一对 `[Subagent started]` / `[Subagent done]`。子 agent 通常会自己把活干完，或者回一句它没有这个工具。

这里是拷贝而不是别名的意义所在：下游章节往 `tools` 里加东西（s07 加 skill 相关工具）不会顺带漏进 `subTools`。真要确认这条边界，把 `main.ts:78` 临时改成 `const subTools = tools;` 再跑同一个 prompt，就能看到嵌套的 `[Subagent started]`，验完改回去。

万一子 agent 硬发一个未声明的工具名，子循环走 `Unknown: <name>`（`main.ts:178`）回给它，循环不中断。
