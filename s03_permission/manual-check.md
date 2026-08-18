# s03: Permission 手动验证清单

s01/s02 的循环与工具行为不再重复验证，这里只看三道关卡，以及 `main.test.ts` 用 fake confirm 覆盖不到的部分：真实 readline 提示、transcript 记录、s02 的 safePath 被移除后的行为差异。

## 1. 三关都不命中：直接执行

- `What files are in the current directory?`
- `Write a file tmp/note.txt with content "hello s03"`

不打印 `[permission]` 也不打印 `[blocked]`，工具直接跑。日常读写走的就是这条路。

## 2. 关卡 1 硬拒绝：不给批准机会

- `Run this exact command: sudo ls`
- `Run this exact command: dd if=/dev/zero of=/dev/null count=1`

两条都直接返回红色 `[blocked] Blocked: '<pattern>' is on the deny list`（`main.ts:280`），不弹 `Allow? [y/N]`。喂回模型的是 `Permission denied by rule or user.`（`main.ts:332`），看它是解释还是换一种写法重试。

两条都选了即使名单失效也不会造成破坏的命令：`sudo ls` 只列目录，`dd` 从 `/dev/zero` 读一个 block 写到 `/dev/null`。

关卡 1 只对 `bash` 生效（`main.ts:277`）：`Write a file tmp/deny.txt with content "sudo ls"` 里同样的字符串在 `write_file` 上不触发名单，因为它检查的是命令而不是文件内容。

## 3. 关卡 2 + 3：同一个调用分别选 y 和 N

- `Delete the file tmp/note.txt`

模型会用 `bash` + `rm`，命中 `"rm "` 关键字（`main.ts:191`），提示 `[permission] Potentially destructive command`，下一行打印完整的 `bash({"command":"..."})`，让你在批准前看清参数。

跑两遍：输 `n`（或直接回车）时文件还在，模型收到 denied；输 `y` 时命令真的执行，文件消失。只有 `y` / `yes` 算允许（`main.ts:230`）。

## 4. 越界文件工具：s02 拦死，s03 可以放行

- `Read the file /etc/hosts`
- `Write "x" to /tmp/escape.txt`

在 s02 这两条固定返回 `Error: Path escapes workspace`；s03 里 safePath 硬拦截已从文件工具移除（`main.ts:83-129`），改由规则 1（`main.ts:180`）提示 `Access outside workspace` 并交给你决定。选 `y` 时读写真的发生在工作区外，这正是两层不能并存的原因：safePath 还在的话，你点「允许」也没用。
