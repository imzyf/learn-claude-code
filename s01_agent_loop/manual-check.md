# s01: Agent Loop 手动验证清单

本章的机制：模型返回 `tool_use` 就执行并把结果喂回去，不返回就结束这一轮。

```sh
pnpm dev s01_agent_loop/main.ts
```

## 1. 调工具就继续，不调就停

- `List all files in this directory`
  列出当前目录下的所有文件。
- `Say hello without running any command`
  不要运行任何命令，直接打个招呼。

第一条走 `tool_use` -> 执行 -> 结果喂回 -> 回答；第二条一轮就结束。

## 2. 一次响应里多个 tool_use

- `Create three files: .tmp/a.txt, .tmp/b.txt, .tmp/c.txt, each containing its own filename`
  创建三个文件 .tmp/a.txt、.tmp/b.txt、.tmp/c.txt，每个文件的内容就是它自己的文件名。

多个 `tool_use` block 按顺序执行，结果合并进同一条 user 消息。

## 3. 多轮循环 + 上下文保留

同一 session 连续两条：

1. `Create a file called .tmp/counter.txt with content 0`
   创建 .tmp/counter.txt，内容为 0。
2. `Increment the number in .tmp/counter.txt by 1`
   把 .tmp/counter.txt 里的数字加 1。

第二条不用重述文件路径，说明 history 跨轮累积；它本身也要先读再写，说明一轮用户输入里循环跑了不止一次。

## 4. 错误也喂回模型

- `Run this exact command: sudo ls`
  原样运行这条命令：sudo ls。
- `Run a command that doesn't exist, like 'thiscommanddoesnotexist123'`
  运行一个不存在的命令，比如 thiscommanddoesnotexist123。

第一条被危险命令检查拦下，返回 `Error: Dangerous command blocked`；第二条的 stderr 被合并进工具输出。两种错误都进上下文，看模型是解释还是换写法重试。
