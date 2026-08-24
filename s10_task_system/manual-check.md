# s10: Task System 手动验证清单

本章的机制：一个落在磁盘上的任务图，一个任务一份 JSON，边靠 `blockedBy` 记，状态机是 `pending -> in_progress -> completed`。这份清单验六件事：任务图是不是分两阶段建起来的、依赖没完成时认领会不会被挡住、完成任务时汇报的「解除阻塞」准不准、加边时的自依赖与成环有没有被拦、任务图退出重进还在不在、以及任务 ID 拼进文件名这条路上的越界。

```sh
# 必须在仓库根目录跑：存储目录要求在 process.cwd() 之内
pnpm dev s10_task_system/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s10_task_system/.log -name '*_transcript.log' | sort | tail -1)"
```

任务目录跟着章节走，不在仓库根：`s10_task_system/.tasks/`。这跟 s09 的 `.memory/` 不一样，别找错地方。

任务是有状态的，每节之间会互相干扰。开始前先清干净，需要重来时也是这一条：

```sh
rm -rf s10_task_system/.tasks
```

## 1. 两阶段建图：先建节点，再用返回的 ID 加边

```sh
rm -rf s10_task_system/.tasks && pnpm dev s10_task_system/main.ts
```

- `Plan a small feature as tasks: design the DB schema, then build the API on top of it, then write tests for the API, and write docs that also depend on the schema. Set up the dependencies.`
  把一个小功能拆成任务：先设计数据库 schema，再在它之上做 API，然后给 API 写测试，另外写文档，文档同样依赖 schema。把依赖关系建好。

期望顺序是：先若干次 `create_task`（可能在同一条回复里并行发出），拿到 ID 之后再若干次 `update_task`。终端上是蓝字：

```plaintext
  [create] design the DB schema
  [create] build the API
  ...
  [update] build the API blockedBy: task_xxxxxxxx
```

**判据是 `create_task` 的入参里没有任何依赖信息**。它的 schema 只有 `subject` 和 `description`，多传一个字段会被 `additionalProperties: false` 拦成 `Error: ...`，这条错误会出现在 `TOOL RESULT (create_task)` 里。

为什么必须分两阶段：模型可以在一条回复里并行发出多个 `create_task`，这些同级调用在任何 `tool_result` 回传之前就已经定稿，所以某个 `create_task` 拿不到兄弟调用刚生成的 ID。在 transcript 的 `ASSISTANT` 一节里看这点最直观：同一条回复里几个 `🔧 create_task(...)` 挨在一起，ID 是 `TOOL RESULT` 里才回来的。

模型一次只建一个任务、串行地建完再加边，也算通过，只是慢。模型压根不调 `update_task`、把依赖只写在 `description` 里，那是 SYSTEM prompt 没起作用，属于模型行为，换个更明确的说法再试一次。

## 2. 磁盘上的任务图

跑完第 1 节，不退出，另一个终端看：

```sh
ls s10_task_system/.tasks/
cat s10_task_system/.tasks/task_*.json
```

- 文件名是 `task_` 加 8 位十六进制，一个任务一份，没有汇总文件。
- 每份 JSON 六个字段：`id`、`subject`、`description`、`status`、`owner`、`blockedBy`。刚建出来时 `status` 是 `pending`、`owner` 是 `null`、`blockedBy` 是 `[]`。
- 加过边的任务，`blockedBy` 里是依赖任务的 ID，方向是「我被谁挡住」，不是「我挡住谁」。

回到 REPL 里让模型 `list_tasks`，对照一遍渲染：

```plaintext
[ ] task_xxxxxxxx: design the DB schema [pending]
[ ] task_yyyyyyyy: build the API [pending] (blockedBy: task_xxxxxxxx)
```

三个 marker 都要认一遍：`[ ]` pending、`[>]` in_progress、`[x]` completed。列表按文件名排序，ID 是随机的，所以顺序稳定但跟创建时间无关。

## 3. 依赖没完成就认领不了

- `Claim the API task now.`
  现在认领 API 那个任务。

期望 `tool_result` 是：

```plaintext
Blocked by: [task_xxxxxxxx]
```

同时磁盘上那份 JSON **没有变**：`status` 还是 `pending`，`owner` 还是 `null`。校验失败时根本没走到保存，这一点在文件里比在终端上更可信。

再让它认领没有依赖的那个 schema 任务，对照一遍：

- `Claim the schema task and start working on it.`
  认领 schema 那个任务并开始做。

期望青字：

```plaintext
  [claim] design the DB schema -> in_progress (owner: agent)
```

一挡一放，才说明挡的是依赖，不是「认领功能坏了」。

## 4. 完成任务：owner 校验与「刚被解除阻塞」

- `Finish the schema task.`
  完成 schema 那个任务。

期望绿字加黄字：

```plaintext
  [complete] design the DB schema
  [unblocked] build the API, write docs
```

`Unblocked` 那行只列**刚刚**从阻塞变成可开始的任务，判据有两条：

- `write tests` 依赖的是 API 而不是 schema，所以这次**不该**出现在 `Unblocked` 里。出现了，说明就绪判定把「依赖的依赖」也算成了就绪。
- 没有依赖的任务任何时候都不进这个列表。

接着完成 API 任务，这一轮 `Unblocked` 应该只有 `write tests`，`write docs` 不该被重复汇报 —— 它上一轮就已经就绪了。重复汇报是本节最容易出的 bug：就绪快照如果取在保存之后，每次完成都会把所有就绪任务重报一遍。

owner 校验没法从 REPL 里撞到（handler 把 owner 写死成 `agent`），手工改文件可以：把某个 `in_progress` 任务的 `owner` 改成 `alice`，再让模型完成它，期望 `Task task_xxx is owned by alice, not agent`。多 agent 抢任务是 s13 的事，这里只验这条边界还在。

## 5. 自依赖与成环

- `Make the schema task depend on the docs task.`
  让 schema 任务依赖 docs 任务。（docs 已经依赖 schema）

期望 `tool_result` 里是 `Error: Dependency cycle detected: task_xxx -> task_yyy`。环检测从候选依赖出发沿 `blockedBy` 走，能走回自己就是环，所以间接环（A -> B -> C，再给 A 加 C）也该被拦住，这正是上面这句要试的情况。

- `Make the tests task depend on itself.`
  让 tests 任务依赖它自己。

期望 `Error: Task cannot depend on itself`。

两条的共同判据是：**抛错之后那份 JSON 一个字节没变**。加边是先整轮校验再统一保存，一次调用里给了三个依赖、第三个成环，前两个也不该被写进去：

- `Make the tests task depend on the schema task, the API task, and the tests task itself, all in one call.`
  在同一次调用里，让 tests 任务同时依赖 schema 任务、API 任务和它自己。

期望整次拒绝，`blockedBy` 保持原样。

还有一条：已认领的任务不再改依赖。让模型给一个 `in_progress` 的任务加依赖，期望 `Error: Task task_xxx dependencies can only be updated while pending and unowned`。任务已经开工了还能往上加阻塞，就绪判定就会在中途反悔。

## 6. 非法 ID 进不了文件系统，也不该让 REPL 退出

任务 ID 会被直接拼进文件名，所以这条有实际攻击面。三道防线叠着，从外往里：

- **schema 层**：`update_task` 的两个 ID 参数都带 `pattern: ^task_[0-9a-f]{8}$`，模型在 JSON Schema 里看得见，多半根本不会发出非法 ID。
- **dispatch 层**：真发出来了，schema 解析抛错，收敛成 `Error: ...` 回给模型。
- **store 层**：拼路径**之前**先校验 ID，`..` 之类的输入连文件名都构不成。

`get_task` 的 schema 是裸字符串，正好用来验第三道：

- `Get the task with id ../../../etc/passwd`
  取 id 为 ../../../etc/passwd 的任务。
- `Get the task with id task_zzzzzzzz`
  取 id 为 task_zzzzzzzz 的任务。

期望两次都是 `Error: Invalid task ID: ...`，REPL 继续等下一句话，`s10_task_system/.tasks/` 外没有任何新文件，`git status` 干净。

REPL 因为这类输入退出，是本章最严重的 bug：一个模型幻觉出来的 ID 不该能终止会话。

## 7. 跨会话：任务图留在磁盘上

这是本章跟 s05 的 `todo_write` 最大的差别 —— 那边清单在内存里，一退出就没了。

输入 `q` 退出，重新跑起来再问：

- `What tasks are pending, and which one can I start next?`
  哪些任务还是 pending？下一个能开始的是哪个？

期望 `list_tasks` 返回的还是上一次那些任务，`completed` 的还是 `completed`，`blockedBy` 的边还在。恢复不需要任何加载步骤，读文件就是恢复。

注意对照的是**磁盘**，不是模型的记忆：新会话的 history 是空的，模型能说出上次的任务，只可能是因为它调了 `list_tasks`。模型凭空复述出上次的内容而 transcript 里没有 `TOOL RESULT (list_tasks)`，那是它在编。

## 8. 手改坏的任务文件在读取处就报错

任务文件是普通 JSON，人可以改，旧版本也可能留下缺字段的文件。读取时整份过一遍 schema。挑一个任务文件，把 `status` 改成一个不存在的值，再在 REPL 里让模型 `list_tasks`，期望是一条 `Error: ...` 回到 `tool_result` 里，而不是列表少了一行、或者某处崩掉。

校验放在读取处是为了让报错离现场近：`blockedBy` 缺字段这种问题，不在读取时拦下来，就会拖到用它取长度那一行才炸，堆栈指向一个跟原因无关的位置。

再验一次「未知字段不被洗掉」：往某个任务文件里手工加一个 `"worktree": "demo"`，跑一次 `claim_task`（会触发一次读写往返），期望这个字段还在。schema 用的是 `z.looseObject` 而不是 `z.object`，就是为了这个：s13 在 `Task` 上加了自己的字段并共用这个 store，strip 语义会在一次往返里把它们静默删掉。字段没了就是 bug，而且是那种只在下游章节才暴露的 bug。

---

跑完全部八节记得清场：`rm -rf s10_task_system/.tasks`。日志在 `s10_task_system/.log/`，按需清理。
