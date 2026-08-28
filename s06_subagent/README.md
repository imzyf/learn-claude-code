# s06: Subagent 手动验证清单

本章的机制：`task` 起一个 `messages[]` 全新的子循环，只把最终文本还给父 agent。这份清单验三件事：委派真的发生了、父上下文只拿到那段摘要、父子共用 hook 与 `WORKDIR` 的边界在哪。

```sh
pnpm dev s06_subagent/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s06_subagent/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 父子工具表：6 个 vs 5 个（无 `task`）

`.log/*_api.json` 第一条 `config`（无 `scope` 字段，即 main）的 `tools` 应该是 6 个：s02 的 5 个基础工具加一个 `task`。子 agent 的工具表 `subTools` 也会落到同一份日志：一次委派后应该能找到第二条 `config`，带 `"scope": "sub"`，`tools` 只有基础工具、没有 `task`。

## 2. 一次委派：终端上父子两路输出

- `Use a subtask to find what testing framework this project uses`
  起一个子任务，查出这个项目用的是哪个测试框架。

期望顺序（颜色在括号里）：

1. `🔧 task({"prompt":"..."})`（青，父 agent）
2. `[Subagent started]`（品红）
3. 子 agent 的每一轮：`[sub] 🔧 read_file({...})`（青）、`[sub] [read_file] ...`（灰，输出预览）
4. `[HOOK] Stop(summaryHook): session used N tool calls`（灰）
5. `[Subagent done]`（品红）
6. `[HOOK] Stop(summaryHook): session used M tool calls`（灰）
7. 父 agent 的最终回答（绿）

两个观察点：

- 第 3 步的输出预览只有子 agent 有，父循环没有这一行。所以终端上看得见的工具输出都来自子 agent。
- `[HOOK]` 开头的行**不带** `[sub]` 前缀，哪怕它记录的是子 agent 的工具调用。原因是 hook 实例持的是父 logger，只有子循环自己派生了 `child("sub")`。前缀标的是「哪个 logger 写的」，不是「哪个 agent 干的」。

第 4 和第 6 步是同一个 `summaryHook`、不同的 `messages`：子循环退出前也跑 Stop hook，数的是子 agent 自己那份；父 agent 那条数的是整个 history。所以一轮里出现两条 Stop 行是正常的，N 通常小于 M。

上下文隔离的证据在 transcript 里：`TOOL RESULT (task)` 一节正文应该是一段结论（比如「vitest」），**不含**子 agent 读过的文件内容；紧随其后的父 `REQUEST` 计数是 `N messages (2 new)`，`chars` 不会因为子 agent 读了几万字符而暴涨。想直接看请求体，在 `.log/*_api.json` 里对照：带 `"scope": "sub"` 的 `api_request` 有子 agent 的完整消息，父 agent 的 `api_request` 里一条都没有。

## 3. 每次 task 都是一个新 scope

- `Use two separate subtasks: one to count the .ts files in lib/, another to read the name field in package.json.`
  用两个独立的子任务：一个数 lib/ 下的 .ts 文件个数，一个读 package.json 里的 name 字段。

每次委派都新建一个 `sub` scope，而增量计数是每个 scope 各自维护的。所以第二个子 agent 的第一节应该重新从 `[sub] REQUEST ... 1 messages (1 new)` 开始，而不是接着第一个往上加。

终端上 `[Subagent started]` / `[Subagent done]` 必须成对且不嵌套：`task` 是同步 `await` 的，第一个结束后第二个才开始。

## 4. 子 agent 不能再委派

- `Use a task; inside that task, tell the subagent to delegate again with another task.`
  起一个 task，并在这个 task 里让子 agent 再用一个 task 继续委派。

这里用拷贝而不是别名的意义：下游章节往父工具表里加东西（s07 加技能相关工具）不会顺带漏进 `subTools`。要确认这条边界，把 `subTools` 临时改成 `const subTools = tools;` 再跑同一个 prompt，就能看到嵌套的 `[Subagent started]`，验完改回去。
