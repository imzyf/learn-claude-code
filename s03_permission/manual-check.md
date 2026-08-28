# s03: Permission 手动验证清单

本章的机制：`agentLoop` 在每个 `tool_use` 执行前先跑 `checkPermission`，三道关卡串在一起。关卡 1 是只对 `bash` 生效的硬拒绝名单，命中就直接返回，不给批准机会；关卡 2 按工具名匹配规则（文件工具的路径落在工作区外、bash 命令处在命令位置上的 `rm`/`del`/`unlink`）；命中规则的调用进关卡 3，打印告警并等你输 `y`。任何一关拦下来，喂回模型的都是 `Permission denied by rule or user.`，同时往 transcript 写一节 `PERMISSION`。

```sh
pnpm dev s03_permission/main.ts
```

## 1. 三关都不命中的调用直接执行

同一 session 连续两条：

```prompt
What files are in the current directory?
当前目录里有哪些文件？

Write a file .tmp/note.txt with content "hello s03"
写文件 .tmp/note.txt，内容是 hello s03
```

两条都不出现 `[blocked]` 或 `[permission]`，工具调用行下面直接跟灰色输出预览。日常读写走的就是这条路，也顺手造出后面几节要删的 `.tmp/note.txt`。

```plaintext
🔧 bash({"command":"ls"})
...
🔧 write_file({"path":".tmp/note.txt","content":"hello s03"})
Wrote 9 bytes to .tmp/note.txt
```

## 2. 关卡 1 命中就不弹批准提示

```prompt
Run this exact command: sudo ls
原样运行这条命令：sudo ls

Run this exact command: dd if=/dev/zero of=/dev/null count=1
原样运行这条命令：dd if=/dev/zero of=/dev/null count=1
```

期望红色的一行拦截文案，`Allow? [y/N]` 根本不出现，命令也没交给 shell：

```plaintext
🔧 bash({"command":"sudo ls"})

[blocked] Blocked: 'sudo' is on the deny list
```

第二条的 pattern 是 `dd if=`。模型收到的都是 `Permission denied by rule or user.`，它通常会解释一句为什么没执行。

关卡 1 只在 `block.name === "bash"` 时才跑：

```prompt
Write a file .tmp/deny.txt with content "sudo ls"
写文件 .tmp/deny.txt，内容是 sudo ls
```

同样的字符串在 `write_file` 上不触发名单，文件正常写出来，因为名单检查的是命令而不是文件内容。

## 3. 同一条 rm 调用，输 N 文件还在，输 y 文件消失

```prompt
Delete the file .tmp/note.txt
删除文件 .tmp/note.txt
```

模型会用 `bash` + `rm`，命中关卡 2 的删除命令匹配，进关卡 3：

```plaintext
🔧 bash({"command":"rm .tmp/note.txt"})

[permission] Potentially destructive command
   Tool: bash({"command":"rm .tmp/note.txt"})
   Allow? [y/N]
```

`Tool:` 那行打的是完整的 `input`，不走 `preview` 截断，让你在批准前看清参数。

跑两遍：输 `n` 或直接回车时文件还在，模型收到 denied；输 `y` 时命令真的执行，`.tmp/note.txt` 消失。只有 `y` 和 `yes` 算允许，`Y`/`YES` 因为先做了 `toLowerCase()` 也算。

## 4. 关卡 2 认的是命令名，不是子串

三条都应该弹出 `[permission] Potentially destructive command`：

```prompt
Run this exact command: ls .tmp; rm .tmp/deny.txt
原样运行这条命令：ls .tmp; rm .tmp/deny.txt

Run this exact command: del test.txt
原样运行这条命令：del test.txt

Run this exact command: DEL test.txt
原样运行这条命令：DEL test.txt
```

第一条说明分隔符后面的 `rm` 也算；后两条是 Windows 的删除命令，正则带 `i` 标志所以大小写都认。`del`/`DEL` 在 macOS/Linux 上会因为找不到命令而失败，这里看的是提示有没有弹出来，不是命令跑没跑成。

下面两条应该直接执行，不弹提示：

```prompt
Run this exact command: echo del test.txt
原样运行这条命令：echo del test.txt

Run this exact command: echo delimiter model
原样运行这条命令：echo delimiter model
```

```plaintext
🔧 bash({"command":"echo delimiter model"})
delimiter model
```

`del` 出现在参数位置上，或者只是 `delimiter`、`model` 里的一截字母，都不是删除命令。换成子串匹配这几条会全部误报。

分不出命令名的破坏性写法仍然按子串匹配，这条也弹提示：

```prompt
Run this exact command: chmod 777 .tmp
原样运行这条命令：chmod 777 .tmp
```

## 5. 文件工具越界从硬拦截改成交给人决定

```prompt
Read the file /etc/hosts using the read_file tool. Do not use bash.
用 read_file 工具读文件 /etc/hosts，禁止使用 bash

Write "x" to /tmp/escape.txt using the write_file tool. Do not use bash.
用 write_file 工具往 /tmp/escape.txt 写 x，禁止使用 bash
```

s02 里这两条固定返回 `Error: Path escapes workspace`；s03 把 `safePath` 从文件工具里移除了，改由关卡 2 的规则 1 提示并等你决定：

```plaintext
🔧 read_file({"path":"/etc/hosts"})

[permission] Access outside workspace
   Tool: read_file({"path":"/etc/hosts"})
   Allow? [y/N]
```

选 `y` 时读写真的发生在工作区外，`/tmp/escape.txt` 会被创建出来。

prompt 里那句「禁止使用 bash」不能省：不加的话模型有时直接用 `bash` 跑 `cat /etc/hosts`、`echo x > /tmp/escape.txt`，这两条既不命中拒绝名单也不命中删除命令匹配，会直接放行，验的就不是规则 1 了。

## 6. 每次权限决定都落进 transcript

判据在 `.log/` 下本次运行那份 `_transcript.log` 里的 `PERMISSION` 小节。关卡 1 的拦截、关卡 3 里输 `n` 和输 `y` 各写一节，正文三行：告警原因、完整的 `工具名(input)`、`Decision: deny` 或 `Decision: allow`。

```plaintext
Potentially destructive command
Tool: bash({"command":"rm .tmp/note.txt"})
Decision: allow
```

被拦下的调用没有对应的 `TOOL RESULT` 小节，因为工具压根没执行。喂回模型的那句 `Permission denied by rule or user.` 出现在 `_api.json` 的下一条 `api_request` 里，作为该 `tool_use_id` 的 `tool_result`。
