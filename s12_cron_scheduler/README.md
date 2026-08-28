# s12: Cron Scheduler 手动验证清单

本章的机制：一个 1 秒定时器按本地时间扫描已注册的 cron 任务，到期的推进 `cronQueue`；另一个 200ms 定时器（队列处理器）看到队列非空且 agent 空闲时，自己起一轮 agent loop，把 `[Scheduled] <prompt>` 当作 user 消息注入。交付是至少一次：任务先标 `pendingDelivery` 落盘再进队列，模型成功接收后才销账。这份清单验七件事：注册到交付的整条链路、同一分钟只入队一次、一次性与周期任务销账后的差别、durable 任务重启后恢复、定时回合遇到要确认的工具时直接拒绝、用户输入与定时回合互斥且能正常退出、以及 5 段表达式的校验。

```sh
# 必须在仓库根目录跑：工具以 process.cwd() 为根
pnpm dev s12_cron_scheduler/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s12_cron_scheduler/.log -name '*_transcript.log' | sort | tail -1)"
```

开跑前先确认 `s12_cron_scheduler/.scheduled_tasks.json` 不存在。上次验证留下的 durable 任务会在启动时被重新加载，之后每一节看到的触发都分不清是这次注册的还是上次的。

启动应该先出三行，第三行说明两个定时器都起来了：

```plaintext
s12: Cron Scheduler - 独立定时器 + 队列处理器
  [cron scheduler] timer started
  [queue processor] started
```

## 1. 注册 -> 到期 -> 交付

- `Schedule "use bash to print the current date" every minute, recurring, and keep it after restart.`
  注册一个每分钟跑一次的任务，内容是用 bash 打印当前时间，周期执行，重启后保留。

期望这一轮里出现紫字，`cron_` 后面是随机 ID：

```plaintext
  [cron register] cron_9f3a1c04 '* * * * *' -> use bash to print the current date
```

表达式不是 `* * * * *` 也行（`*/1 * * * *` 等价），但必须是 5 段。模型写成 `0 * * * * *` 会被拒，见第 7 节。

然后不要输入任何东西，等到下一个整分钟。期望依次出现：

```plaintext
  [cron push queue] cron_9f3a1c04 -> use bash to print the current date
  [queue processor] delivering scheduled work
  [inject cron] use bash to print the current date
```

三行分属三层：第一行是 1 秒定时器判断时间后入队，第二行是队列处理器发现队列非空且 agent 空闲，第三行是 agent loop 把任务注入 messages。中间隔了 200ms 以内。

这三行里只有 `[cron push queue]` 和 `[inject cron]` 走 `logger.console`，会同时进 transcript；`[queue processor] delivering scheduled work` 只打终端。要在 transcript 里确认交付，看 `CRON STATE` 和 `REQUEST` 两节。

`[Scheduled]` 消息的正文只落在 `_api.json` 里（transcript 的 `REQUEST` 一节只记条数和字符数）：

```sh
grep '\[Scheduled\]' "$(find s12_cron_scheduler/.log -name '*_api.json' | sort | tail -1)"
```

```plaintext
        "content": "[Scheduled] use bash to print the current date"
```

这条消息的 `role` 必须是 `user`。模型随后应该调 bash 跑 `date`，终端上能看到 `🔧 bash(...)` 和绿色的回答。

还有一条 TS 特有的判据：整个过程中提示符 `s12 >> ` 始终在最下面一行，不会被上面的输出顶掉。这是 `lib/terminal.ts` 的 `createPrompt` 在等输入期间先擦掉提示符行、输出完再重画。如果提示符被冲散、或者你已经输入到一半的字被吃掉，就是这一层出了问题。

## 2. 同一分钟只入队一次

调度定时器每秒跑一次 `runCronTick`，一分钟内会扫到同一个任务 60 次。接着第 1 节那个每分钟任务，观察连续两分钟：

- 每分钟只有一条 `[cron push queue]`，不是 60 条。
- transcript 里 `CRON STATE` 一节的 `last=` 是分钟级标记，形如 `last=2026-08-25 14:07`。

```plaintext
── [14:07:01] CRON STATE ──────────────────────────
  1 job(s), queue=0
    cron_9f3a1c04 '* * * * *' [recurring,durable] last=2026-08-25 14:07 -> use bash to print the current date
──
```

去重靠两个字段：`lastFired` 记到分钟，`pendingDelivery` 表示上一次还没被模型接收。`lastFired` 带日期，所以每日任务在第二天不会被误判成已触发过。

## 3. 一次性任务销账后消失，周期任务继续

- `Also schedule a one-shot job for the next minute that just says "one-shot fired", not recurring. Then list all cron jobs.`
  再注册一个下一分钟执行的一次性任务，内容是说一句 one-shot fired，不要周期执行。然后列出所有 cron 任务。

`list_crons` 的输出里，两条任务的标签应该不同：

```plaintext
  cron_9f3a1c04: '* * * * *' -> use bash to print the current date [recurring, durable]
  cron_5b71e2aa: '8 14 * * *' -> say one-shot fired [one-shot, durable]
```

等那一分钟到，交付完成后再输入 `List all cron jobs.`。期望一次性任务已经不在列表里，周期任务还在。

要看清「先交付、后销账」这个顺序，翻 transcript 里那一轮的 `CRON STATE`：交付那一轮的开头，一次性任务仍然注册着，标志里带 `pending`；模型回完之后的下一节 `CRON STATE` 里它才消失。这就是至少一次交付的代价，进程如果在这两步之间退出，重启后会再交付一次。

## 4. durable 落盘与重启恢复

落盘文件在章节目录下，不是仓库根：

```sh
cat s12_cron_scheduler/.scheduled_tasks.json
```

```json
[
  {
    "id": "cron_9f3a1c04",
    "cron": "* * * * *",
    "prompt": "use bash to print the current date",
    "recurring": true,
    "durable": true,
    "pendingDelivery": false,
    "lastFired": "2026-08-25 14:07"
  }
]
```

再注册一个只在本次会话有效的任务做对照：

- `Schedule "say session only" every minute but do not keep it after restart.`
  注册一个每分钟执行的任务，内容是说一句 session only，重启后不要保留。

这条注册后 `.scheduled_tasks.json` 里不该多出第二项，`list_crons` 里它的标签是 `[recurring, session]`。

然后 `q` 退出，重新 `pnpm dev s12_cron_scheduler/main.ts`。期望启动时出现：

```plaintext
  [cron] loaded 1 durable job(s)
```

`List all cron jobs.` 应该只剩 durable 那一条，session 那条没了。停机期间错过的时间点不会补跑：重启后不会立刻涌出一堆 `[Scheduled]`，要等下一个匹配的分钟。

顺手验一下损坏文件不被静默忽略。退出进程，把文件改成非法内容再启动：

```sh
printf 'not json' > s12_cron_scheduler/.scheduled_tasks.json
pnpm dev s12_cron_scheduler/main.ts
```

期望红字报错并继续启动，不是崩溃，也不是一声不吭：

```plaintext
  [cron] failed to load durable jobs: Unexpected token 'o', "not json" is not valid JSON
```

单条任务非法（比如把某条的 `cron` 手工改成 `61 9 * * *`）走的是另一条路径，只跳过那一条：

```plaintext
  [cron] skipping invalid job: CronPattern: Invalid value for minute: 61
```

验完把文件删掉，回到干净状态。

## 5. 定时回合不能占用主终端问 y/N

定时回合和用户在同一个终端上，如果它调用了需要确认的工具，`Allow? [y/N]` 会和主提示符抢 stdin。入口为定时回合单独装了一套 hook，`confirm` 直接返回 false。

- `Schedule a one-shot job for the next minute with this exact prompt: run "rm .tmp/s12-check" with bash.`
  注册一个下一分钟执行的一次性任务，内容原样是：用 bash 跑 `rm .tmp/s12-check`。（这个文件不存在，放行了也只是报一句 No such file）

等它到期。期望黄字，并且终端上不出现 `Allow? [y/N]`：

```plaintext
  [permission] scheduled turn cannot ask: Potentially destructive command (bash)
```

`tool_result` 是 `Permission denied by user`，在 transcript 的 `TOOL RESULT (bash)` 一节里能看到。

对照一组：直接在提示符里输入 `Run "rm .tmp/s12-check" with bash.`，这一轮走的是主 hook，应该正常停下来问：

```plaintext
[permission] Potentially destructive command
   Tool: bash({"command":"rm .tmp/s12-check"})
   Allow? [y/N]
```

答 `n` 即可。两组对照说明同一个 `permissionHook` 拿到的是两个不同的 `Confirm` 实现，区别只在入口注入了什么。

拒绝名单那一关不分回合，两边都是硬拦。定时任务里塞 `sudo ls` 会得到红字 `[HOOK] PreToolUse(permissionHook): Blocked: 'sudo' is on the deny list`，`tool_result` 是 `Permission denied by deny list`。

## 6. 用户输入与定时回合互斥，退出不被定时器拖住

`agentBusy` 是 Python `agent_lock` 在单线程事件循环里的等价物：队列处理器占用时直接跳过，用户输入则阻塞等它释放。

保留第 1 节那个每分钟任务，在整分钟前后输入一个问题，例如 `What is 2 + 2?`，然后立刻回车。期望的现象是：如果定时回合正好在跑，你的问题不会立刻发出，要等 `[Scheduled]` 那一轮结束（绿色回答出现）之后才开始新一轮。两轮的输出不会交错。

对照 transcript：`REQUEST` 一节是串行的，不会出现某一轮的 `REQUEST` 夹在另一轮的 `REQUEST` 和 `ASSISTANT` 之间。

反过来，用户回合也会消费队列：如果你输入问题的时候队列里已经有到期任务，这一轮的 messages 里会同时有你的问题和 `[Scheduled]` 消息，不会另起一轮。这是设计如此，和 code.py 一致。

退出这一节是 Node 特有的。输入 `q`，期望进程立刻退回 shell，不会因为两个 `setInterval` 还挂着而卡住。两个定时器都调了 `unref()`，不算活跃句柄。`Ctrl+D` 走的是另一条路径（stdin 关闭，`prompt.ask()` 抛错后 break），也应该立刻退出。

## 7. 只收 5 段表达式

croner 本身接受 5、6、7 段，本章是分钟粒度，匹配前会把秒清零，收下带秒的表达式只会退化成每分钟触发一次。所以段数在进 croner 之前自己卡死。

- `Schedule a job with the cron expression "0 0 9 * * *" and the prompt "six fields".`
  用 cron 表达式 `0 0 9 * * *` 注册一个任务，内容是 six fields。

期望 `tool_result` 是错误字符串，任务没有被注册：

```plaintext
Error: Expected 5 fields, got 6
```

模型多半会自己改成 5 段再试一次，那是对的，`0 9 * * *` 应该注册成功。取值越界仍然由 croner 判：`61 9 * * *` 得到 `Error: CronPattern: Invalid value for minute: 61`。两类错误都会原样回给模型，不是静默降级。

验完记得清场：

```sh
rm -f s12_cron_scheduler/.scheduled_tasks.json
```
