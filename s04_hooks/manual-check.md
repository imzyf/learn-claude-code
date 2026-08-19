# s04: Hooks 手动验证清单

本章的机制：把权限判定和日志改写成挂在四个时点上的 hook（`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`），同一时点的多个 hook 按注册顺序跑，第一个返回非 null 的就短路。

```sh
pnpm dev s04_hooks/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s04_hooks/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 启动即写 HOOK REGISTER

REPL 启动后还没输入任何问题，transcript 里就应该有一节 `HOOK REGISTER`：

```plaintext
UserPromptSubmit: contextInjectHook
PreToolUse:       permissionHook, logHook
PostToolUse:      largeOutputHook
Stop:             summaryHook
```

`PreToolUse` 那行的两个名字必须是这个顺序，顺序决定第 3 节的结果。

## 2. 一次正常调用：四个 hook 的时间线

- `What files are in the current directory?`
  当前目录里有哪些文件？

终端上按这个顺序出现（颜色在括号里）：

1. `[HOOK] UserPromptSubmit(contextInjectHook): working in <cwd>`（灰）
2. `🔧 bash({"command":"ls"})`（青）
3. `[HOOK] PreToolUse(logHook): bash`（灰）
4. 工具输出预览（灰）
5. `[HOOK] Stop(summaryHook): session used 1 tool calls`（灰）
6. 最终回答（绿）

第 1 步在 agent 循环之外触发，所以每轮用户输入只出现一次，而不是每次 LLM 往返一次。

第 5 步的计数值得多试一轮：

- `Now count the lines in package.json`
  数一下 package.json 有多少行。

第二轮的 `session used N tool calls` 会累加，因为它数的是整个 history 里的 `tool_result`，不是本轮的。

## 3. PreToolUse 的短路

- `Run this exact command: sudo ls`
  原样运行这条命令：sudo ls。

预期只看到红色 `[HOOK] PreToolUse(permissionHook): Blocked: 'sudo' is on the deny list`，**不会**看到 `[HOOK] PreToolUse(logHook): bash`。被拦的调用因此不会进日志。

## 4. hook 里 await 用户输入

先造出文件，再删：

- `Write a file .tmp/note.txt with content "hi"`
  写文件 .tmp/note.txt，内容是 hi。
- `Delete the file .tmp/note.txt`
  删除文件 .tmp/note.txt。

命中破坏性规则，`permissionHook` 会 `await confirm(...)`，弹出 `Allow? [y/N]`。

## 5. PostToolUse 拿到输出但不改它

- `Read the file package.json`
  读文件 package.json。

正常输出下 `largeOutputHook` 静默（阈值 10 万字符），观察点是「没有告警」加上「模型收到的内容和终端预览一致」。

- `Run this exact command: yes hello | head -c 200000`
  原样运行这条命令：yes hello | head -c 200000。

这条**不会**告警，而这正是要验证的点：`runBash` 返回前先把输出截到 5 万字符，够不着 10 万的阈值。

告警只能走不截断的 `read_file`。先造一个大文件：

```sh
node -e 'require("fs").writeFileSync(".tmp/big.txt","x".repeat(150000))'
```

- `Read the file .tmp/big.txt`
  读文件 .tmp/big.txt。

期望黄色 `[HOOK] PostToolUse(largeOutputHook): Large output from read_file: 150000 chars`。告警之后模型收到的仍是完整输出：PostToolUse 只观察，不改结果。

## 6. Stop hook 强制续轮（`S04_FORCE_STOP_HOOK=1`）

默认的 `summaryHook` 永远返回 null，所以「Stop hook 让循环自己续命」正常运行时走不到。想在真实模型上看一次：

```sh
S04_FORCE_STOP_HOOK=1 pnpm dev s04_hooks/main.ts
```

这会额外注册一个一次性 Stop hook（见 `registerDefaultHooks`）：模型第一次不再调用工具时，这个 hook 不返回 `null`，而是返回一句话，`agentLoop` 把它当成新的 user 消息塞回 `messages` 并 `continue`；第二次触发时一次性标记已用过，返回 `null`，循环才真正退出。

- `Read the file package.json`
  读文件 package.json。

预期时间线：

1. 模型读完文件、准备结束时，先出现黄色一行：
   `[HOOK] Stop hook forced another round: Before you finish, list the files you touched.`
2. 这句话被当成新一轮 user 输入送回模型，模型据此列出它读过的文件，再次尝试结束。
3. 第二次触发 Stop hook 返回 `null`，循环退出，出现最终绿色回答。

一条 prompt 换来两轮 assistant 回复，中间夹着那条黄色续轮提示，就是「Stop hook 让循环自己续命」的效果。
