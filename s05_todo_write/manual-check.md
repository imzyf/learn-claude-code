# s05: TodoWrite 手动验证清单

工具分发、权限关卡、hook 机制分别在 [s02](../s02_tool_use/manual-check.md)、[s03](../s03_permission/manual-check.md)、[s04](../s04_hooks/manual-check.md) 的清单里验过，这里只看 s05 的新东西：`todo_write` 这个「只改状态、不干活」的工具，以及唠叨计数器。重点放在 `main.test.ts` 用 fake client 覆盖不到的部分：真实模型愿不愿意主动规划、终端渲染、transcript 里的 `TASKS` / `[NAG]` 记录。

```sh
pnpm dev s05_todo_write/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s05_todo_write/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 启动即写 HOOK REGISTER

和 s04 一样，还没输入任何问题时 transcript 里就该有一节 `HOOK REGISTER`：

```plaintext
UserPromptSubmit: contextInjectHook
PreToolUse:       permissionHook, logHook
PostToolUse:      largeOutputHook
Stop:             summaryHook
```

和 s04 的那份逐条对比，只有一处不同：s04 的 `Stop` 行还有一个匿名 hook（那个强制续轮的演示 hook），s05 没有（`main.ts:287-294`）。`permissionHook` 也换成了 s05 的精简版：只剩拒绝名单，不再有 `Allow? [y/N]` 关卡。

## 2. 模型会不会主动先规划

- `Create lib/slug.ts with a slugify(text) function, write 3 vitest cases in lib/slug.test.ts, run the tests, and fix any failures.`

这是 SYSTEM prompt 那句「Before starting any multi-step task, use todo_write to plan your steps」（`main.ts:82-85`）唯一的验证方式：**第一个**工具调用应该就是 `todo_write`，而不是 `write_file`。终端上先出现黄色标题和清单：

```plaintext
## Current Tasks
[>] Create lib/slug.ts with slugify
[ ] Write 3 vitest cases
[ ] Run tests and fix failures

(0/3 completed)
```

三个 marker 都要认一遍：`[ ]` pending、`[>]` in_progress、`[x]` completed（`main.ts:160-171`）。清单渲染成什么样，模型收到的 `tool_result` 就是什么样，同一份字符串。

如果模型直接开写文件、跳过规划，说明 prompt 没起作用——这属于模型行为，不是 bug，多试两次或换个更明显的多步任务。

## 3. 状态推进：清单是模型自己维护的

跟着上一步继续跑，每完成一步模型应该重新调一次 `todo_write`，把上一条改成 `[x]`、下一条改成 `[>]`，末尾的 `(N/3 completed)` 递增。

值得盯的是：清单**没有**自动推进机制。`TODO.items` 只在 `todo_write` 被调用时整体替换（`main.ts:156`），工具执行本身不会碰它。所以如果模型写完文件却忘了更新，清单就会停在旧状态——这正是第 5 项那个提醒存在的理由。

transcript 里每次调用留一节 `TASKS`，格式和终端不同（用 status 名而不是 marker，便于 grep）：

```plaintext
[completed] Create lib/slug.ts with slugify
[in_progress] Write 3 vitest cases
[pending] Run tests and fix failures
```

## 4. 三条校验规则，让模型自己撞一次

这三条在 `main.test.ts` 里都是直接调函数验的，手动跑的价值在于看模型收到错误文案之后会不会自己改对。

- `Use todo_write to create a plan where two items are in_progress at the same time.`

预期 `Error: Only one todo can be in_progress at a time`（`main.ts:152-154`），且清单**不变**——校验失败时 `this.items` 根本没被赋值，旧清单还在。模型通常会立刻重发一份只留一个 `in_progress` 的。

- `Use todo_write to create a plan with 25 items.`

预期 `Error: Max 20 todos allowed`（`main.ts:97`、`main.ts:140-142`）。注意 tool 声明里已经写了 `maxItems: 20`（`main.ts:214-219`），所以模型多半根本不会发过来，这条得靠模型硬发 25 条才撞得到。

- 结构非法的输入（漏 `status`、条目不是对象）很难靠 prompt 稳定诱发，交给单测覆盖即可：`pnpm test s05_todo_write`。手动跑时只需记住一点——这类输入**不能**让 REPL 退出。dispatch 处的 schema 故意放行一切 `todos`（`main.ts:204-209`），校验只在 `TodoManager` 里做，结果是 `Error: todos[0] has invalid status` 这样一条回给模型的文案。

## 5. 唠叨提醒：连续 3 轮不更新就补一条

- `Read package.json, then read tsconfig.json, then read biome.json, then list the files in lib/.` （中途别提 todo）

前三个工具轮次一路 `nag.bump()`（`main.ts:379`），第三轮结束时计数到 3，终端打出一行黄字，同时 transcript 里留一节 `CONSOLE PRINT`：

```plaintext
[NAG] 连续 3 轮未更新 todo，注入 <reminder>
```

这条提醒**不是**单独一条消息，它作为一个 text block 挂在第三轮 `tool_result` 那条 user 消息的末尾（`main.ts:337-348`），和 `code.py:321-324` 一致。在 transcript 的 `REQUEST` 段里确认一下：那条 user 消息应该是 `tool_result` 后面跟一个 `<reminder>Update your todos.</reminder>`，而不是又起一条 user 消息。

紧接着的一轮，模型通常会调 `todo_write`，此时 `nag.reset()`（`main.ts:408`）把计数清零，再连续 3 轮不更新才会有下一条。

计数器是 `agentLoop` 每次调用新建的（`createNagCounter`，`main.ts:308-350`），所以换一条新问题就从 0 开始：先跑一个只用 2 个工具轮次的问题，再跑一个同样 2 轮的问题，全程不该出现 `[NAG]`。如果出现了，说明计数跨用户轮残留了。
