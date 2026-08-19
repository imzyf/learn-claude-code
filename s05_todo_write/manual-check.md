# s05: TodoWrite 手动验证清单

本章的机制：`todo_write` 是个只改状态、不干活的工具，清单完全由模型自己维护；加一个唠叨计数器，连续 3 个工具轮次不更新就往 `tool_result` 后面挂一条提醒。

```sh
pnpm dev s05_todo_write/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s05_todo_write/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 模型会不会主动先规划

- `Create .tmp/slug.ts with a slugify(text) function, write 3 vitest cases in .tmp/slug.test.ts, run the tests, and fix any failures.`
  创建 .tmp/slug.ts 并写一个 slugify(text) 函数，在 .tmp/slug.test.ts 里写 3 个 vitest 用例，跑测试，修掉失败。

SYSTEM prompt 那句「Before starting any multi-step task, use todo_write to plan your steps」只能这样验：**第一个**工具调用应该是 `todo_write`，而不是 `write_file`。终端先出现黄色标题和清单：

```plaintext
## Current Tasks
[>] Create .tmp/slug.ts with slugify function
[ ] Create .tmp/slug.test.ts with 3 vitest cases
[ ] Run vitest and fix failures

(0/3 completed)
```

## 2. 状态推进：清单没有自动机制

跟着上一步继续跑，每完成一步模型应重新调一次 `todo_write`，上一条改成 `[x]`、下一条改成 `[>]`，末尾的 `(N/3 completed)` 递增。

值得盯的是：清单只在 `todo_write` 被调用时整体替换，工具执行本身不会碰它。模型写完文件却忘了更新，清单就停在旧状态，这正是第 4 节那条提醒存在的理由。

## 3. 校验规则：让模型自己撞一次

手动跑的价值在于看模型收到错误文案之后会不会自己改对。

- `Use todo_write to create a plan where two items are in_progress at the same time.`
  用 todo_write 建一份计划，让两个条目同时处于 in_progress。

预期 `Error: Only one todo can be in_progress at a time`，且清单**不变**：校验失败时根本没赋值，旧清单还在。模型通常会立刻重发一份只留一个 `in_progress` 的。

- `Use todo_write to create a plan with 25 items.`
  用 todo_write 建一份有 25 个条目的计划。

预期 `Error: Max 20 todos allowed`。工具声明里已经写了 `maxItems: 20`，模型多半根本不会发过来，这条得靠它硬发 25 条才撞得到。

## 4. 唠叨提醒：连续 3 轮不更新就补一条

- `Read package.json, then read tsconfig.json, then read biome.json, then list the files in lib/.`
  依次读 package.json、tsconfig.json、biome.json，然后列出 lib/ 下的文件。（中途别提 todo）

第三个工具轮次结束时计数到 3，终端打出一行黄字，transcript 里留一节 `CONSOLE PRINT`：

```plaintext
[NAG] 连续 3 轮未更新 todo，注入 <reminder>
```

这条提醒**不是**单独一条消息，它作为一个 text block 挂在第三轮 `tool_result` 那条 user 消息的末尾。紧接着的一轮模型通常会调 `todo_write`，计数清零，再连续 3 轮不更新才有下一条。
