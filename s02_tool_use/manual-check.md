# s02: Tool Use 手动验证清单

s01 的循环行为不再重复验证，这里只看新增的五工具 dispatch 和 safePath。

## 1. dispatch 分发表：一句话跑遍五个工具

- `Use glob to list the *.ts files in this directory, then read main.ts with limit 5`

`glob` -> `read_file` 两次分发（`main.ts:214`），日志里能看到 `block.name` 和查表命中的 handler。`limit 5` 生效时输出末行是 `... (N more lines)`（`main.ts:68`）。

## 2. write_file -> edit_file -> read_file

同一 session 连续三条：

1. `Write a file tmp/note.txt with content "hello world"`
2. `In tmp/note.txt, replace "world" with "s02"`
3. `Read tmp/note.txt`

第一条会自动建 `tmp/` 目录（`main.ts:83`），返回 `Wrote N bytes`；第二条返回 `Edited tmp/note.txt`；第三条确认内容是 `hello s02`。

## 3. edit_file 找不到目标文本

- `In tmp/note.txt, replace "not-present-text" with "x"`

返回 `Error: text not found in tmp/note.txt`（`main.ts:98`），错误喂回模型后它通常会改成先 `read_file` 再重试。这一条同时验证 `runEdit` 用的是 `indexOf + slice`：把 `new_text` 写成 `$&` 也应原样落到文件里，不被当成替换语法。

## 4. safePath 越界拦截

- `Read the file ../../etc/hosts`
- `Write "x" to /tmp/escape.txt`

两条都返回 `Error: Path escapes workspace: ...`（`main.ts:55`），文件工具被限制在 `WORKDIR` 内。

注意这里和 Python 原版有差异：Node 的 `path.resolve()` 只做词法归一化，不展开 symlink，所以 workspace 内指向外部的 symlink 能通过检查。可以在仓库里 `ln -s /etc/hosts link.txt` 后让它 `Read link.txt` 复现。
