# s13: Agent Teams 手动验证清单

本章的机制：一个 Lead 加若干持久队友，队友是游离的 async 循环，在 WORK 和 IDLE 之间切换；通信走文件邮箱（`.mailboxes/<agent>.jsonl`，读取即消费），任务走共享任务板（`.tasks/`），工作目录由任务的 `worktree` 绑定决定。入口用一个事件队列同时接收用户输入和 250ms 轮询发现的 Lead 收件箱事件。这份清单验八件事：spawn 前先等用户确认、队友事件怎么回流成新一轮、计划闸门拦不拦得住修改型工具、worktree 决定队友的 cwd、一个 owner 只能有一项进行中的任务加 IDLE 自己找活、队友那侧不读终端问权限、关机协议的往返、以及提示符与退出。

## 起跑

```sh
# 必须在仓库根目录跑：工具和 worktree 校验都以 process.cwd() 为根
pnpm dev s13_agent_teams/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s13_agent_teams/.log -name '*_transcript.log' | sort | tail -1)"
```

团队状态跨会话留在磁盘上，开跑前先清干净，需要重来时也是这一条：

```sh
rm -rf s13_agent_teams/.tasks s13_agent_teams/.mailboxes .tmp/s13-check
git worktree list   # 除仓库根外不该有 s13_agent_teams/.worktrees/ 下的条目
```

后面多次要取本次运行的日志，先在校验终端里存两个变量：

```sh
T=$(find s13_agent_teams/.log -name '*_transcript.log' | sort | tail -1)
A=$(find s13_agent_teams/.log -name '*_api.json' | sort | tail -1)
```

transcript 里队友的记录带 scope 前缀，`[alice] REQUEST`、`[alice] TOOL RESULT (bash)` 这样，Lead 的记录没有前缀。`  [bus] ...` 那行走的是 `print`，只打终端，不进 transcript。

## 1. 先提团队方案，用户确认后才 spawn

- `Set up a scratch area under .tmp/s13-check as three tasks. Task A: write .tmp/s13-check/config.json containing exactly {"name": "s13-check", "version": "1.0.0"}. Task B: write .tmp/s13-check/README.md whose first line is "# s13-check". Task C: use bash to verify config.json parses as JSON with name "s13-check", and that README.md's first line is "# s13-check". A and B are independent; C depends on both. Do the independent work in parallel.`
  在 `.tmp/s13-check` 下建草稿区，拆成三个任务。A：写 `config.json`，内容恰好是 `{"name": "s13-check", "version": "1.0.0"}`。B：写 `README.md`，首行是 `# s13-check`。C：用 bash 校验 `config.json` 能解析成 JSON 且 `name` 是 `s13-check`，`README.md` 首行是 `# s13-check`。A、B 互不依赖，C 依赖它们。互不依赖的部分并行做。

`.tmp/` 是 gitignore 目录，三个任务都是从零建文件。`write_file` 里有 `mkdirSync`，父目录会自己建出来，所以不用单独安排一个建目录的任务；Lead 真建了这么一个任务不算错，只是多一步。

期望这一轮 Lead 只建任务并提出分工方案，然后停下来问你要不要开始。跑完这一轮在校验终端上判：

```sh
grep -c 'TOOL RESULT (create_task)' "$T"   # 期望 3
grep -c 'spawn_teammate' "$T"              # 期望 0
```

终端上也不该有紫字 `[teammate] ... spawned`。这条约束写在 SYSTEM 的 `teams` 一节里（`Do not call spawn_teammate before the user confirms`），Lead 不等确认就直接派人属于模型没照做，换一次更明确的说法再试。

- `Go ahead.`
  开始吧。

期望依次出现青字和紫字，subject 是模型写的，看得出是任务 A 就行：

```plaintext
  [claim] write config.json -> in_progress (owner: alice)
  [teammate] alice spawned as implementer
```

顺序是先认领后启动：`spawnTeammateThread` 先替队友 `claimTask`，认领失败就不启动队友，工具返回 `Cannot spawn teammate 'alice': ...`，`list_teammates` 里也不会有它。名字冲突和保留名各有一条：重名回 `Teammate 'alice' already exists`，用 `lead` 或 `agent` 回 `Invalid teammate name: 'lead' is reserved by the runtime`。

`spawn_teammate` 的 `tool_result` 末尾要求 Lead 收尾：

```plaintext
Teammate 'alice' spawned as implementer for task_xxxxxxxx. End this turn; the runtime will deliver its events.
```

Lead 接着反复调 `list_teammates` 等结果是模型行为，不是运行时坏了：事件会由 wake 送回来，见第 2 节。

任务 A、B 都完成之后，产物可以直接判：

```sh
cat .tmp/s13-check/config.json   # 期望 {"name": "s13-check", "version": "1.0.0"}
head -1 .tmp/s13-check/README.md # 期望 # s13-check
```

## 2. 队友事件回流成新一轮

队友说完一轮话会发两条消息：`result` 是产出，`idle_notification` 是「还能接活」。终端上是灰字：

```plaintext
  [bus] alice -> lead: (result) Created .tmp/s13-check/config.json with
  [bus] alice -> lead: (idle_notification) Waiting for more work.
```

250ms 轮询看到 Lead 收件箱非空就推一个 wake 事件，主循环消费收件箱并起新一轮，黄字：

```plaintext
[wake: 2 team event(s) -> new turn]
```

注入 history 的正文只落在 `_api.json` 里（transcript 的 `REQUEST` 一节只记条数和字符数）：

```sh
grep -A3 'Team events' "$A"
```

```plaintext
        "content": "[Team events]\n[result] alice: ...\n[idle_notification] alice: Waiting for more work."
```

邮箱是即读即消费（`readFile` + `unlink`）。在队友干活期间另一个终端反复看：

```sh
ls s13_agent_teams/.mailboxes/
```

`lead.jsonl` 应该只在消息投递到被 wake 消费之间的这段时间存在，消费后文件消失，不是留在磁盘上被读第二遍。对应的判据是同一条 `result` 不会在两轮的 `[Team events]` 里各出现一次：

```sh
grep -c 'Created .tmp/s13-check/config.json' "$A"   # 期望 1
```

Lead 正在跑 `agentLoop` 时新事件只进队列不插队：`[wake: ...]` 不会打断上一轮的工具调用，两轮的 `REQUEST` 在 transcript 里是串行的。

## 3. 计划闸门拦住修改型工具

闸门是按 owner 记的，跟当前有没有任务无关。alice 已经空闲也照样能置位，等她下次认领任务动手时才撞上。

- `Ask alice for a plan before she changes anything.`
  在 alice 动手之前先要一份计划。

`request_plan` 把闸门置成 `required` 并投一条 `plan_request`。此时队友调 `bash` / `write_file` / `edit_file` 会拿到：

```plaintext
Blocked: plan status is required. Submit or revise the plan and wait for approval before changing the workspace.
```

alice 手上没活时看不到这一条，就再给她派一个会改文件的任务把它逼出来：

- `Create a task to append the line "checked by alice" to .tmp/s13-check/README.md and give it to alice.`
  建一个任务：往 `README.md` 追加一行 `checked by alice`，派给 alice。

队友随后调 `submit_plan`，闸门转 `pending`：

```plaintext
Plan submitted (req_123456). Wait for Lead's decision.
```

计划以 `plan_approval_request` 事件送到 Lead，`[Team events]` 里带 `request_id=req_123456`。

- `Approve alice's plan.`
  批准 alice 的计划。

期望紫字，`req_` 后面是随机 ID：

```plaintext
  [protocol] req_123456 -> approved
```

队友下一轮的 messages 里会多一条 `[Plan approved] ...`，之后修改型工具才放行，那一行 `checked by alice` 这时才会落到文件里。拒绝走同一条路：`review_plan` 传 `approve: false`，闸门变 `rejected`，队友要重新 `submit_plan`，闸门没回到 `approved` 之前 `complete_task` 也被拦：

```plaintext
Task task_xxxxxxxx cannot complete while plan status is rejected
```

闸门只拦 `bash` / `write_file` / `edit_file` 三个（`GATED_TOOLS`）。`read_file` 和 `glob` 在等审批期间照样能用，这是有意的：让队友先看代码再写计划。

## 4. worktree 决定队友的工作目录

worktree 要在任务还是 `pending`、无人认领的时候建。先建任务、建 worktree，再派人。

这一节另起一个跟 A/B/C 无关的任务。绑了 worktree 的队友 cwd 是 checkout 目录，它写出来的相对路径落在 `.worktrees/s13-auth/` 里面，不是仓库根。拿任务 B 来演示的话，`README.md` 会写进 worktree，仓库根那份不存在，任务 C 反而会失败。

- `Create a task to write NOTES.md at the top of the workspace with the single line "worktree probe", with no dependencies. Create a worktree named "s13-auth" for that task, then spawn bob on it.`
  建一个没有依赖的任务：在工作区顶层写 `NOTES.md`，内容只有一行 `worktree probe`。给这个任务建一个叫 `s13-auth` 的 worktree，然后派 bob 去做。

期望黄字和工具返回：

```plaintext
  [worktree] created: s13-auth at /Users/.../s13_agent_teams/.worktrees/s13-auth
Worktree 's13-auth' created at /Users/.../s13_agent_teams/.worktrees/s13-auth for task_xxxxxxxx
```

顺序反了会被拦：任务已经被认领时建 worktree 得到 `Error: Task task_xxxxxxxx must be pending and unowned`。`list_tasks` 的渲染会多一列 `(worktree: s13-auth)`。

bob 干完之后，文件落在哪里就是这一节的判据：

```sh
cat s13_agent_teams/.worktrees/s13-auth/NOTES.md   # 期望 worktree probe
ls NOTES.md                                        # 期望 No such file or directory
```

再让 bob 用 bash 跑 `pwd`，输出应该是 `.worktrees/s13-auth` 那个路径。对照组是没绑 worktree 的 alice，它的 `pwd` 是仓库根。Lead 自己没有 assignment 时也用仓库根。

没认领任务的队友根本拿不到工作区工具：

```plaintext
Error: Claim a Task before using workspace tools.
```

绑定坏了要 fail closed，不回退到仓库目录。手工制造一次，趁下一个绑 worktree 的任务还没被认领时把 checkout 删掉：

```sh
rm -rf s13_agent_teams/.worktrees/s13-auth
```

再让谁去认领那个任务，期望：

```plaintext
Cannot claim task_xxxxxxxx: worktree 's13-auth' is missing at /Users/.../.worktrees/s13-auth
```

分支还在（`git branch --list 'wt/*'`），Git 的注册项也还在，得手工清，见最后一节。模型工具集里没有移除 worktree 的工具：`removeWorktree` 是宿主函数，`tools` 里只有 `create_worktree`。

工作目录在一轮之内是稳定的，`complete_task` 失败也不动它。`completeTask` 的每一条失败分支都直接 `return` 错误字符串，不碰 `team.assignments`（s13_agent_teams/main.ts:684）；成功分支也不立刻归还，lease 要等模型这一轮结束、`releaseCompletedAssignment` 跑过才释放（s13_agent_teams/main.ts:1353）。逼一次失败：趁 bob 还在 worktree 任务上，让 Lead 发 `Tell bob to complete <alice 的任务 ID>`，期望 bob 拿到

```plaintext
Task task_xxxxxxxx is owned by alice, not bob
```

紧接着让 bob 跑 `pwd`，仍然是 `.worktrees/s13-auth`。这一步要模型照着做才撞得出来，没撞出来不算运行时有问题。`main.test.ts` 只断言了成功路径的 lease 保留（完成后 `assignments` 里仍是同一个 taskId），失败路径不动 assignment 这一点目前没有对应断言，就靠这里手工看。

## 5. 一个 owner 一项任务，IDLE 自己找活

这条要趁 alice 还在 `in_progress` 的时候发，她已经空闲就撞不出错误。任务 A 的 `[claim]` 出现之后、`[complete]` 出现之前是窗口。

- `Have alice pick up the verification task too.`
  让 alice 把校验任务也接过去。

期望这一条，`claimTask` 先看 assignment：

```plaintext
Owner alice must finish the current work turn for task_xxxxxxxx before claiming another task
```

assignment 已经释放但任务还挂在她名下时，走的是另一条分支，句式不同，两条都算通过：

```plaintext
Owner alice must complete task_xxxxxxxx before claiming another task
```

等 alice 完成当前任务并发出 `idle_notification` 之后，别再指派，改成只建一个没有依赖的新任务：

- `Create a task to append the line "idle pickup" to .tmp/s13-check/README.md, and do not assign it to anyone.`
  建一个任务：往 `.tmp/s13-check/README.md` 追加一行 `idle pickup`。不要指派给任何人。

期望两秒内（`IDLE_SCAN_INTERVAL_MS` 是 2000）出现紫字，队友自己扫到并认领：

```plaintext
  [idle] alice claimed task_yyyyyyyy: append a line to README
```

优先级是收件箱在前、扫描在后：`waitForWork` 先等消息，超时没消息才扫任务板。要看这一点，在有 ready 任务挂着的时候让 Lead 给 idle 队友发一条 `send_message`，队友应该先处理那条消息。

被依赖挡住的任务不会被自动认领：`scanUnclaimedTasks` 只收 `pending`、无 owner、依赖已完成、worktree 绑定可用的任务。任务 C 就是现成的例子，A 和 B 都完成之前，idle 队友扫到它也不会认领；两个前置完成后 `complete_task` 的返回里会多一行 `Unblocked: ...`，终端上出现黄字 `  [unblocked] verify both files`，之后它才进候选。

## 6. 队友那侧不读终端问权限

队友没有终端可以问 y/N，权限在 `runTeammateTool` 里自己判完就回错误。

- `Tell bob to run "rm -f .tmp/s13-check/tmp.txt" with bash.`
  让 bob 用 bash 跑 `rm -f .tmp/s13-check/tmp.txt`。

期望 `tool_result` 是这一句，并且终端上不出现 `Allow? [y/N]`：

```plaintext
Permission required: ask Lead to run this command.
```

命中的是 s03 的规则 2（bash 命令含 `rm`），不是拒绝名单。三类结果各有一条：

| 输入 | 返回 |
| --- | --- |
| `rm -f ...` | `Permission required: ask Lead to run this command.` |
| `write_file` 写 `/tmp/x` 这种工作区外的路径 | `Permission required: path is outside the workspace.` |
| `sudo ls` | `Blocked: 'sudo' is on the deny list` |

拒绝名单那条直接原样回 s03 的文案，不再包一层。

对照组：同一条命令由 Lead 自己跑，走的是主 hook，应该停下来问：

```plaintext
[permission] Potentially destructive command
   Tool: bash({"command":"rm -f .tmp/s13-check/tmp.txt"})
   Allow? [y/N]
```

答 `n` 即可。还有一条 hook 层面的判据：队友那次调用会打 `[HOOK] PreToolUse(logHook): bash`，但不会打 `[HOOK] PreToolUse(permissionHook): ...`。这是 `triggerSkippingPermission` 的效果，其余 hook 照常触发，`PostToolUse` 的 `largeOutputHook` 也一样。

## 7. 关机协议

- `Shut alice and bob down.`
  让 alice 和 bob 关闭。

期望工具返回带 request_id，队友确认后紫字收尾：

```plaintext
Shutdown requested from alice (req_654321)
  [bus] alice -> lead: (shutdown_response) Shutdown acknowledged.
  [protocol] req_654321 -> approved
  [teammate] alice finished
```

两个都退出、收件箱也空了之后，下一轮结束时打一行紫字 `[all teammates shut down]`。

队友退出时没做完的任务会被放回任务板：`releaseTeammateAssignment` 把它改回 `pending`、`owner` 清空。验一遍就问 `List all tasks.`，那条任务应该回到 `[ ]` 且不带 `[alice]`。已完成的任务不受影响。磁盘上也能判：

```sh
grep -l '"status": "in_progress"' s13_agent_teams/.tasks/task_*.json   # 期望没有输出
```

`request_id` 的错配与重复生效（回复类型不对、回复方不对、同一个请求批两次）从 REPL 里撞不到，那几条由 `main.test.ts` 的 `team protocols` 覆盖；这里只确认正常路径走通。

## 8. 提示符与退出

整个过程里提示符 `s13 >> ` 始终在最下面一行：队友的 `[bus]`、`[claim]`、wake 的输出都从它上方流过，你输入到一半的字不会被吃掉。这是 `lib/terminal.ts` 的 `createPrompt` 在等输入期间擦掉提示符行、输出完再重画。

留一个 idle 队友不关，直接输入 `q`。期望进程立刻退回 shell，不会被队友的等待卡住：`waitForMessages` 的定时器和 250ms 轮询都调了 `unref()`。`Ctrl+D` 走 `rl` 的 close 事件，推一个 quit 事件，同样立刻退出。

这样退出不会给队友发关机请求，队友的 `finally` 也就不会跑。手上还有 `in_progress` 任务的队友，那条任务会带着 `owner` 留在 `.tasks/` 里：

```sh
grep -l '"status": "in_progress"' s13_agent_teams/.tasks/task_*.json   # 期望有输出
```

跟第 7 节正好相反：走关机协议任务回到 `pending`，直接 `q` 就留在 `in_progress`。下次启动时那个 owner 已经不存在，任务卡住没人能完成。要接着验就清任务板，见下面一节。

## 9. 已知失败模式：队友在 WORK 循环里空转

验证期间终端可能持续刷同一行：

```plaintext
[HOOK] PreToolUse(logHook): complete_task
[HOOK] PreToolUse(logHook): complete_task
```

这不是 hook 出问题。`logHook` 每次工具调用打一行，队友走 `triggerSkippingPermission` 也照打，所以刷屏只说明有人在高频调工具。去 transcript 里认是谁：

```sh
grep -A2 'TOOL RESULT (complete_task)' "$T" | sort | uniq -c | sort -rn | head
```

典型输出是同一句错误重复几十次，任务在更早的时候其实已经完成过一次：

```plaintext
  41 Task task_175e045a is completed, cannot complete
   1 Completed task_175e045a (write config.json)
```

机制上循环停不下来：`work()` 只看响应里有没有 `tool_use`，有就 `return "continue"`，`run()` 的 `while (state !== "stop")` 没有轮次上限，只有「这一轮模型不调工具」才会转 IDLE。`tool_result` 是错误文本这件事对循环没有意义。模型认定任务没做完、反复重发同一个 `complete_task`，就一直转，每转一圈都是一次完整 API 调用，context 还在涨。

这是模型行为，不是移植缺陷：`code.py` 的 `complete_task` 对已完成任务同样返回 `Task ... is completed, cannot complete`，`run()` 同样是没有上限的 `while state != "stop"`。本章有意不加轮次上限或幂等豁免，教学代码保持和上游一致。

两种停法：

- Lead 还能接受输入时用 `Shut alice down.`。`work()` 每轮开头先读收件箱，`shutdown_request` 会让它 `return "stop"`，未完成任务被放回任务板，比杀进程干净。
- Ctrl+C。`rl` 的 SIGINT 直接 `process.exit(0)`。这时 `q` 不一定马上生效：队友卡在 API 请求上，那个 socket 还是活跃句柄。

看到这个现象就中止本轮，它每转一圈都在花钱。

## 清场

```sh
rm -rf s13_agent_teams/.tasks s13_agent_teams/.mailboxes .tmp/s13-check
```

worktree 得手工清，本章有意不替用户删 Git 数据：

```sh
git worktree list
git worktree remove s13_agent_teams/.worktrees/s13-auth
git branch -D wt/s13-auth
```

checkout 已经被手工删掉的情况用 `git worktree prune` 清注册项，分支仍要单独删。第 4 节写在 worktree 里的 `NOTES.md` 随 checkout 一起没了，不用单独删。`.worktrees/` 不在 `.gitignore` 里（`.tasks/` 和 `.mailboxes/` 在），验证期间 `git status` 会把它显示成未跟踪目录 `?? s13_agent_teams/.worktrees/`，清完就没了。
