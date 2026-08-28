# s02: Tool Use 手动验证清单

本章的机制：五个工具走一张 dispatch 分发表，文件类工具统一过 `safePath`，`glob` 的结果排序并截到 200 条。

```sh
pnpm dev s02_tool_use/main.ts
```

## 1. glob -> read_file 连续分发，limit 截断生效

```prompt
Use glob to list the *.ts files in s02_tool_use, then read s02_tool_use/main.ts with limit 5
用 glob 列出 s02_tool_use 目录下的 *.ts 文件，然后用 limit 5 读 s02_tool_use/main.ts
```

期望连着出现两组「工具调用行 + 输出预览」，说明同一轮里 `glob` 和 `read_file` 各走了一次分发表；`glob` 的结果按文件名排序，`main.test.ts` 排在 `main.ts` 前面。`limit` 生效时 `read_file` 的输出末行是 `... (N more lines)`。

```plaintext
🔧 glob({"pattern":"s02_tool_use/*.ts"})
s02_tool_use/main.test.ts
s02_tool_use/main.ts
🔧 read_file({"path":"s02_tool_use/main.ts","limit":5})
<main.ts 前 5 行>
... (N more lines)
<模型的最终回答>
```

## 2. write_file -> edit_file -> read_file

同一 session 连续三条：

```prompt
Write a file .tmp/note.txt with content "hello world"
写文件 .tmp/note.txt，内容是 hello world

In .tmp/note.txt, replace "world" with "s02"
把 .tmp/note.txt 里的 world 换成 s02

Read .tmp/note.txt
读 .tmp/note.txt
```

第一条自动建好 `.tmp/` 目录，第二条按精确字符串替换，第三条确认改动落了盘：

```plaintext
🔧 write_file({"path":".tmp/note.txt","content":"hello world"})
Wrote 11 bytes to .tmp/note.txt
🔧 edit_file({"path":".tmp/note.txt","old_text":"world","new_text":"s02"})
Edited .tmp/note.txt
🔧 read_file({"path":".tmp/note.txt"})
hello s02
```

## 3. edit_file 找不到目标文本

```prompt
Call edit_file on .tmp/note.txt directly with old_text "not-present-text" and new_text "x", without reading the file first
直接调用 edit_file，把 .tmp/note.txt 里的 not-present-text 换成 x，不要先读文件
```

期望文件不被改动，错误原样喂回模型后它通常会改成先 `read_file` 再重试，说明失败结果和正常结果走的是同一条 tool_result 回传路径。

```plaintext
🔧 edit_file({"path":".tmp/note.txt","old_text":"not-present-text","new_text":"x"})
Error: text not found in .tmp/note.txt
```

## 4. safePath 越界拦截

```prompt
Call read_file directly on "../../etc/hosts", without asking or explaining first. Do not use bash
直接调用 read_file 读 ../../etc/hosts，不要先询问或说明，也不要用 bash
```

`Call write_file directly on "/tmp/escape.txt" with content "x", without asking or explaining first. Do not use bash`（往 /tmp/escape.txt 写 x）是同一判据的反面，两条都在越界前被拦下，不落地也不读到工作区外的内容。

```plaintext
🔧 read_file({"path":"../../etc/hosts"})
Error: Path escapes workspace: ../../etc/hosts
```

## 5. glob 结果超过 200 条时截断

```prompt
Use glob to find every file matching **/* in this workspace
用 glob 查找工作区里 **/* 匹配的所有文件
```

装好依赖后仓库里的文件（含 `node_modules`）远超 200 个，触发截断分支。终端上的预览会先被 `preview()` 截到 200 字符（末尾是 `... (N more chars)`），完整的 200 行加提示行要去 `_transcript.log` 里这条 prompt 对应的 `TOOL RESULT (glob)` 小节看，第 201 行固定是 `... (more matches omitted; narrow the pattern)`。

```plaintext
🔧 glob({"pattern":"**/*"})
AGENTS.md
CLAUDE.md
...
... (<N> more chars)
```
