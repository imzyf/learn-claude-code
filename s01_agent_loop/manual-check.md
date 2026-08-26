# s01: Agent Loop 手动验证清单

本章的机制：一个 `while true` 循环。每轮把整个 `messages` 发给模型，响应里有 `tool_use` block 就逐个执行 `bash`，把输出配上 `tool_use_id` 拼成一条 user 消息喂回去，再进下一轮；响应里没有 `tool_use` 就把文本返回，这一轮结束。工具输出无论成功失败都当普通结果送回模型，收发同时落进 `.log/` 下的两份文件。

```sh
pnpm dev s01_agent_loop/main.ts
```

## 1. 调工具就继续，不调就停

```prompt
List all files in this directory
列出当前目录下的所有文件
```

期望终端先出现青色的工具调用行，再出现灰色的输出预览，最后是绿色的回答：

```plaintext
🔧 bash({"command":"ls -la"})
total <N>
drwxr-xr-x  ...
<模型的最终回答>
```

```prompt
Say hello without running any command
不要运行任何命令，直接打个招呼
```

这条期望没有 `🔧` 行，也没有灰色输出，模型的话直接以绿色打出来，提示符立刻回到 `s01 >>`。两条的差别就是这一章的分支：响应里有 `tool_use` 才继续循环。

## 2. 多个 tool_use 合并成一条 user 消息，下一次输入还带着 history

同一 session 连续两条：

```prompt
Create three files: .tmp/a.txt, .tmp/b.txt, .tmp/c.txt, each containing its own filename. Do it in one turn with three separate bash calls
创建三个文件 .tmp/a.txt、.tmp/b.txt、.tmp/c.txt，每个文件的内容就是它自己的文件名。在一轮里用三次独立的 bash 调用完成

Show me the contents of the second file you created
把你刚创建的第二个文件的内容打出来
```

第一条期望终端上连着出现三组「工具调用行 + 输出预览」，中间没有插入新的模型回复：

```plaintext
🔧 bash({"command":"echo a.txt > .tmp/a.txt"})
(no output)
🔧 bash({"command":"echo b.txt > .tmp/b.txt"})
(no output)
🔧 bash({"command":"echo c.txt > .tmp/c.txt"})
(no output)
```

合并的判据在 `_api.json` 最后一条 `api_request`：三个 `tool_result` 在同一条 user 消息里。`_transcript.log` 里这一条输入下面有两组 `REQUEST` / `ASSISTANT`，说明循环跑了不止一轮。

第二条不出现任何文件名，模型仍然要能定位到 `.tmp/b.txt`，打出 `b.txt`，说明 history 跨轮累积：

```plaintext
🔧 bash({"command":"cat .tmp/b.txt"})
b.txt
```

模型也可能把第一条拆成三轮，每轮一个调用，那样验不到合并，把 prompt 里的 `in one turn` 再强调一遍重试。

## 3. 危险命令在执行前被拦下

```prompt
Run this exact command: sudo ls
原样运行这条命令：sudo ls
```

期望灰色预览是固定的一行拦截文案，而不是 `ls` 的目录列表，说明命令根本没有被交给 shell：

```plaintext
🔧 bash({"command":"sudo ls"})
Error: Dangerous command blocked
```

## 4. 命令失败不算异常，照样喂回模型

```prompt
Run a command that doesn't exist, like 'thiscommanddoesnotexist123'
运行一个不存在的命令，比如 thiscommanddoesnotexist123
```

期望 REPL 不中断、不抛栈，灰色预览就是 shell 的报错原文，模型接着这段文本继续说话：

```plaintext
🔧 bash({"command":"thiscommanddoesnotexist123"})
/bin/sh: thiscommanddoesnotexist123: command not found
```
