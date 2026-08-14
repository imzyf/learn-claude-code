# s01: Agent Loop 手动验证清单

## 1. 基础循环：调工具就继续，不调就停

- `List all files in this directory`
- `Say hello without running any command`

第一条走 `tool_use` -> 执行 -> 结果喂回 -> 回答；第二条不调工具，一轮结束。

## 2. 单轮多次 tool_use

- `Create three files: a.txt, b.txt, c.txt, each containing its own filename`

一次响应里多个 `tool_use` block，`main.ts:111` 按顺序执行并合并进同一条 `tool_result`。

## 3. 多轮循环 + 上下文保留

同一 session 连续两条：

1. `Create a file called counter.txt with content 0`
2. `Increment the number in counter.txt by 1`

`history` 跨轮累积（`main.ts:171,185`），第二条不用重述文件路径；第二条本身也需要先读再写，验证循环不止跑一轮。

## 4. 错误反馈

- `Run this exact command: sudo ls`
- `Run a command that doesn't exist, like 'thiscommanddoesnotexist123'`

第一条被 `isDangerous`（`main.ts:71`）拦截，返回 `Error: Dangerous command blocked`；第二条由 `runBash` 把 stderr 合并进输出（`main.ts:67`）。两种错误都喂回模型，看它解释或改策略。
