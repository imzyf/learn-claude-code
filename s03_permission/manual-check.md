# s03: Permission 手动验证清单

本章的机制：工具执行前过三道关卡，拒绝名单硬拦，规则命中则弹 `Allow? [y/N]` 交给人决定。

```sh
pnpm dev s03_permission/main.ts
```

## 1. 三关都不命中：直接执行

- `What files are in the current directory?`
  当前目录里有哪些文件？
- `Write a file .tmp/note.txt with content "hello s03"`
  写文件 .tmp/note.txt，内容是 hello s03。

不打印 `[permission]` 也不打印 `[blocked]`，工具直接跑。日常读写走的就是这条路。

## 2. 关卡 1 硬拒绝：不给批准机会

- `Run this exact command: sudo ls`
  原样运行这条命令：sudo ls。
- `Run this exact command: dd if=/dev/zero of=/dev/null count=1`
  原样运行这条命令：dd if=/dev/zero of=/dev/null count=1。

两条都直接返回红色 `[blocked] Blocked: '<pattern>' is on the deny list`，不弹 `Allow? [y/N]`。喂回模型的是 `Permission denied by rule or user.`

关卡 1 只对 `bash` 生效：

- `Write a file .tmp/deny.txt with content "sudo ls"`
  写文件 .tmp/deny.txt，内容是 sudo ls。

同样的字符串在 `write_file` 上不触发名单，因为它检查的是命令而不是文件内容。

## 3. 关卡 2 + 3：同一个调用分别选 y 和 N

- `Delete the file .tmp/deny.txt`
  删除文件 .tmp/deny.txt。

模型会用 `bash` + `rm`，命中 `"rm "` 关键字，提示 `[permission] Potentially destructive command`，下一行打印完整的 `bash({"command":"..."})`，让你在批准前看清参数。

跑两遍：输 `n`（或直接回车）时文件还在，模型收到 denied；输 `y` 时命令真的执行，文件消失。只有 `y` / `yes` 算允许。

## 4. 越界文件工具：从硬拦截改成交给人决定

- `Read the file /etc/hosts using the read_file tool. Do not use bash.`
  用 read_file 工具读文件 /etc/hosts，禁止使用 bash。
- `Write "x" to /tmp/escape.txt using the write_file tool. Do not use bash.`
  用 write_file 工具往 /tmp/escape.txt 写 x，禁止使用 bash。

不加「禁止使用 bash」的话，模型有时会绕过 `read_file`/`write_file`，直接用 `bash` 跑 `cat`/`echo >` 达到同样效果。`cat /etc/hosts`、`echo x > /tmp/escape.txt` 都不命中关卡 1 的拒绝名单，也不命中关卡 2 的破坏性关键字，会直接放行，测试的就不是本节要验证的规则 1（越界路径）了。

s02 里这两条固定返回 `Error: Path escapes workspace`；s03 把 `safePath` 从文件工具移除了，改由规则提示 `Access outside workspace` 并等你决定。选 `y` 时读写真的发生在工作区外。
