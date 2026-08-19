# s02: Tool Use 手动验证清单

本章的机制：五个工具走一张 dispatch 分发表，文件类工具统一过 `safePath`。

```sh
pnpm dev s02_tool_use/main.ts
```

## 1. 一句话跑遍分发表

- `Use glob to list the *.ts files in this directory, then read main.ts with limit 5`
  用 glob 列出当前目录的 *.ts 文件，然后用 limit 5 读 main.ts。

日志里能看到 `block.name` 和查表命中的 handler。`limit` 生效时输出末行是 `... (N more lines)`。

## 2. write_file -> edit_file -> read_file

同一 session 连续三条：

1. `Write a file .tmp/note.txt with content "hello world"`
   写文件 .tmp/note.txt，内容是 hello world。
2. `In .tmp/note.txt, replace "world" with "s02"`
   把 .tmp/note.txt 里的 world 换成 s02。
3. `Read .tmp/note.txt`
   读 .tmp/note.txt。

第一条自动建 `.tmp/` 目录并返回 `Wrote N bytes`，第二条返回 `Edited .tmp/note.txt`，第三条内容应为 `hello s02`。

## 3. edit_file 找不到目标文本

- `Call edit_file on .tmp/note.txt directly with old_text "not-present-text" and new_text "x", without reading the file first`
  直接调用 edit_file，把 .tmp/note.txt 里的 not-present-text 换成 x，不要先读文件。

返回 `Error: text not found in .tmp/note.txt`，模型通常会改成先读再重试。

## 4. safePath 越界拦截

- `Call read_file directly on "../../etc/hosts", without asking or explaining first. Do not use bash.`
  直接调用 read_file 读 ../../etc/hosts，不要先询问或说明，也不要用 bash。
- `Call write_file directly on "/tmp/escape.txt" with content "x", without asking or explaining first. Do not use bash.`
  直接调用 write_file 往 /tmp/escape.txt 写 x，不要先询问或说明，也不要用 bash。

两条都返回 `Error: Path escapes workspace: ...`。
