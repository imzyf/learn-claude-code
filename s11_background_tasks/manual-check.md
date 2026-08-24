# s11: Background Tasks 手动验证清单

本章的机制：bash 工具多一个 `run_in_background` 参数，命中它的调用不等命令跑完，登记成一个 `bg_` 任务、立刻回一条占位 `tool_result`，循环继续往下走；命令跑完的结果进完成队列，下一次进到循环开头时被收走，包成 `<task_notification>` 注入对话。这份清单验六件事：模型会不会显式请求后台、派发之后循环有没有真的继续、通知是在后续轮次而不是当场注入、PreToolUse 在派发之前生效、退出时还在跑的命令被停掉、以及失败任务带着退出码回来。

```sh
# 必须在仓库根目录跑：工具以 process.cwd() 为根
pnpm dev s11_background_tasks/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s11_background_tasks/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 模型显式请求后台

- `Run "sleep 20 && echo slept" in the background, and while it runs, list all Markdown files at the top level.`
  在后台跑 `sleep 20 && echo slept`，跑的时候顺便列出顶层的所有 Markdown 文件。

期望先出一行黄字，再出占位结果：

```plaintext
  [background] started bg_0001: sleep 20 && echo slept
```

判据是 transcript 的 `ASSISTANT` 一节里那次调用的入参：

```plaintext
[tool_use] bash: {"command":"sleep 20 && echo slept","run_in_background":true}
```

`run_in_background` 缺失或为 `false` 就没进后台，终端上不会有 `[background] started`，命令会同步跑满 20 秒。这是模型行为，不是代码问题：`shouldRunBackground` 只认显式为 `true` 的标志，不按 `install` / `build` / `test` 之类的关键词猜。撞到这种情况，把 prompt 里的 `run_in_background` 参数名直接写出来再试一次。

占位 `tool_result` 的正文只落在 `_api.json` 里（transcript 的 `REQUEST` 一节只记条数和字符数）：

```sh
grep -A2 'Background task' "$(find s11_background_tasks/.log -name '*_api.json' | sort | tail -1)"
```

```plaintext
[Background task bg_0001 started] The result will be collected on a later turn.
```

命令的真实输出（`slept`）**不该**出现在这里。出现了，说明派发路径被跳过、走了前台。

## 2. 派发之后循环继续跑

接着第 1 节，不要输入任何东西，看模型有没有在那 20 秒里继续做事。

期望在 `[background] started` 之后、任务完成之前，transcript 里还有别的工具调用，例如 `TOOL RESULT (glob)`。对照两处时间戳：`BACKGROUND TASK STARTED` 那一节的时间，和后面 `REQUEST` / `TOOL RESULT` 的时间，两者之间应该没有 20 秒的空档。

有空档说明后台派发退化成了同步执行。这一节验的就是这个：Node 只有一个 JS 线程，后台 bash 走的是异步 `spawn`，命令跑的时候事件循环不能被占住。

## 3. 通知在后续轮次收，不主动唤醒 agent

第 1 节那一轮，模型多半列完文件就回答了，此时 `sleep 20` 还没跑完。这一轮结束后：

- 终端应该回到 `s11 >>` 提示符，**没有**任何 `[background] collected`。
- 等 20 秒以上，提示符那里还是什么都不会发生。后台任务跑完不会主动唤醒 agent。

然后随便输入下一个问题，例如：

- `Did the background command finish?`
  后台那条命令跑完了吗？

期望在这一轮的第一次请求之前出现蓝字：

```plaintext
  [background] collected bg_0001: completed
  [inject] 1 background notification(s)
```

transcript 里对应一节 `INJECTED BACKGROUND NOTIFICATIONS`：

```plaintext
<task_notification>
  <task_id>bg_0001</task_id>
  <status>completed</status>
  <command>sleep 20 && echo slept</command>
  <summary>slept</summary>
</task_notification>
```

两条判据：

- 通知里**没有** `tool_use_id`。原始那次 tool call 早就用占位 `tool_result` 回复过了，一个 `tool_use` 只对应一个 `tool_result`，完成结果是作为独立事件进对话的。
- 通知被并进了刚输入的那条 user 消息，不是单开一条。在 `_api.json` 最后一条 `api_request` 里看：末尾那条 user 消息的 `content` 是个数组，第一块是问题原文，第二块才是 `<task_notification>`。两条独立的 user 消息说明合并那一支没走到。

任务在同一轮之内跑完也能收：那种情况下下一次循环迭代（下一次 `REQUEST` 之前）就收走了，不必等到下一次输入。`sleep 2` 配一串文件操作可以撞出来。

## 4. PreToolUse 在派发之前生效

- `Run this exact command in the background: sudo ls`
  原样在后台运行这条命令：sudo ls。

期望红字，并且**没有** `[background] started`：

```plaintext
[HOOK] PreToolUse(permissionHook): Blocked: 'sudo' is on the deny list
```

`tool_result` 是 `Permission denied by deny list`。权限检查留在主线程，拦下就不派发，任务登记簿里不该多出一个 `bg_`。

再试一条要人确认的：

- `Run this exact command in the background: rm .tmp/s11-check`
  原样在后台运行这条命令：rm .tmp/s11-check。（这个文件不存在，放行了也只是报一句 No such file）

期望先停下来问：

```plaintext
[permission] Potentially destructive command
   Tool: bash({"command":"rm .tmp/s11-check","run_in_background":true})
   Allow? [y/N]
```

答 `n`，`tool_result` 是 `Permission denied by user`，同样不该有 `[background] started`。这里要确认的是问话出现在派发之前：后台命令一旦派发就没人能拦，确认必须发生在主线程。

有一条已知的不对称，顺手对照一下：前台 bash 走 s01 的 `runBash`，里面的 `isDangerous` 额外拦 `> /dev/` 和 `osascript`；后台走 `runBashAsync`，不经过 `isDangerous`，这两个关键词只能靠 DENY_LIST，而 DENY_LIST 里没有它们。也就是说 `osascript -e 'beep'` 前台会被 `Error: Dangerous command blocked` 挡住，加上 `run_in_background` 就能跑起来。这是 TS 移植为了复用 s01 而分叉出来的口子，`main.ts:204` 的注释记着它。

## 5. 退出时停掉还在跑的命令

- `Run "sleep 300" in the background.`
  在后台跑 `sleep 300`。

看到 `[background] started` 之后立刻输入 `q`。期望进程马上退回 shell，不是卡在那里等 300 秒。

另一个终端确认没有留下孤儿进程：

```sh
pgrep -f "sleep 300"
```

应该没有输出。

这一节是 Node 特有的：Python 用 daemon 线程，主线程退出就结束；Node 的子进程和它的 stdout / stderr pipe 都 ref 住事件循环，只要还有命令在跑，进程就不会退出，所以 REPL 收到 `q` 之后必须显式调 `stopBackgroundProcesses()`。命令是在独立进程组里起的（`detached`），所以 `sleep 300 | cat` 这种它自己派生出来的子进程也该一起没了，可以拿这条再验一次。

要验 120 秒超时的话，跑 `sleep 130` 并且**不要**退出，等满两分钟，期望收到 `<status>failed</status>`，`<summary>` 是 `Error: Timeout (120s)`。
