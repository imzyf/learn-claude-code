# s07: Skill Loading 手动验证清单

本章的机制：两级加载。启动时扫 `skills/*/SKILL.md`，SYSTEM 里只放「名称 + 一行描述」；完整正文要等模型调 `load_skill` 才通过 `tool_result` 进上下文。

```sh
# 必须在仓库根目录跑：技能目录跟着 process.cwd() 走
pnpm dev s07_skill_loading/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s07_skill_loading/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 启动即写 SKILL CATALOG，一个技能一行

还没输入任何问题时，transcript 的**第一节**就该是 `SKILL CATALOG`（早于 `HOOK REGISTER`）：

```plaintext
- agent-builder: Design and build AI agents for any domain. Use when users: (1) ask to ...
- code-review: Perform thorough code reviews with security, performance, and maintainability analysis. ...
- mcp-builder: Build MCP (Model Context Protocol) servers that give Claude new capabilities. ...
- pdf: Process PDF files - extract text, create PDFs, merge documents. ...
```

三个观察点：

- 四行，按目录名的 codepoint 序排。
- `agent-builder` 的 `description` 在 SKILL.md 里是多行块标量（`description: |`），这里必须压成**一行**。看到它换行了，说明 frontmatter 走的不是 YAML 库那条路。
- 从别的目录启动（比如 `cd s07_skill_loading && pnpm dev ...`）会得到 `(no skills found)`，这不是 bug。

接着看 `.log/*_api.json` 的第一条 `config`：`tools` 是 6 个（5 个基础工具加一个 `load_skill`），`system` 字段里只有上面那四行描述，**不含**任何一份 SKILL.md 正文。这就是本章的全部主张，其余各节都在验证它成立。

## 2. 按需加载：目录里的一行 vs 四千字符的正文

- `Use the code-review skill to review the last commit.`
  用 code-review 技能审查最近一次提交。

期望顺序：

1. `🔧 load_skill({"name":"code-review"})`（青）
2. transcript 里一节 `SKILL`：`load code-review (4266 chars)`
3. transcript 里一节 `TOOL RESULT (load_skill)`：完整的 SKILL.md 正文
4. 模型按 SKILL.md 里的流程开始跑 `bash git log` 之类的工具

第 2 和第 3 节记的是同一件事的不同粒度：`SKILL` 是给人扫读和 grep 的一行摘要，`TOOL RESULT` 是模型实际收到的内容。字符数应与 `wc -c skills/code-review/SKILL.md` 对得上。

隐藏成本在这里显形：对照 `.log/*_api.json`，第一次 `api_request` 的 `chars` 只有目录那点量，`load_skill` 之后那一次会多出四千多字符，并且**此后每一轮都带着它**。没被调用的三个技能，一个字符都没进过上下文。

## 3. 挑错名字时能自己纠正

- `Load the skill called pdf-tools and tell me what it does.`
  加载名为 pdf-tools 的技能，并告诉我它是干什么的。

目录里叫 `pdf`，不叫 `pdf-tools`。预期 `tool_result` 是：

```plaintext
Error: Unknown skill 'pdf-tools'. Available: agent-builder, code-review, mcp-builder, pdf
```

把可选名字一并回给模型，就是为了让它下一轮直接改用 `pdf`，通常一轮就纠正过来。

## 4. 不点名技能时，模型自己挑得中吗

前几节都在 prompt 里直接报了技能名，这节反过来，只描述任务：

- `I need a server that lets Claude query our internal ticket system. Set it up.`
  我需要一个能让 Claude 查询内部工单系统的 server，把它搭起来。（期望 `mcp-builder`）
- `Look at the diff in the working tree and tell me what's risky.`
  看一下工作区里的 diff，告诉我哪里有风险。（期望 `code-review`）

这是 `description` 那一行唯一的验收标准。四份 SKILL.md 的 description 都是「一句功能 + `Use when user asks to ...`」的写法，后半句就是给模型做匹配用的。判定看两点：第一个工具调用是不是 `load_skill`，挑的名字对不对。

挑不中的话先别改代码，去 `SKILL CATALOG` 那一节读一遍：如果某个技能的描述被截在半截、或者只剩一个泛泛的标题（说明它走了「正文首行」那条回退路径），那是描述本身没写出触发条件，不是加载机制的问题。

目录只影响模型「挑不挑」，不影响「能不能调」。哪怕它完全没提技能直接开干，你在下一轮明说技能名，它照样能加载。

## 5. 加载进来的内容真的改变了行为吗

同一个任务问两遍，中间用 `q` 退出重开（换新会话，history 清空）：

1. `Review lib/logger.ts.`
   审查 lib/logger.ts。（如果模型没调 `load_skill` 就直接答，记下它的回答结构）
2. `Use the code-review skill to review lib/logger.ts.`
   用 code-review 技能审查 lib/logger.ts。

第二遍的回答应该贴着 `skills/code-review/SKILL.md` 的 `Review Output Format` 一节走，那里写死了五个标题：

```plaintext
### Summary
### Critical Issues
### Improvements
### Positive Notes
### Verdict
```

出现了就说明 SKILL.md 真的在指挥输出。SKILL.md 不是知识库，是一段临时接进上下文的操作指令。

看不出差别时，去 `TOOL RESULT (load_skill)` 确认内容确实完整进去了（结尾没被截断）。内容进去了但输出没变，那是模型没遵循；内容压根没进去，才是本章的 bug。

## 6. 一次加载，整段会话都在付费

接着第 5 节的会话继续追问，别退出：

- `Now review lib/terminal.ts too.`
  顺便也审查一下 lib/terminal.ts。

期望模型**不再**调 `load_skill`，SKILL.md 已经在 history 里了。transcript 里应该只有一节 `SKILL`，不是两节。

真出现第二节 `SKILL`（同一个技能名）时，看那一轮的请求：两份完全相同的正文并排躺在 messages 里，`chars` 翻倍。这不是错误，`load_skill` 本来就是无状态查表、调几次给几次，但它说明了 s08 要解决的问题：上下文只增不减。

同一会话里换个不相干的技能（`Now use the pdf skill to ...`）则应正常触发一次新的加载，两份内容此后一直共存。这也是本章的取舍：省的是「没被调用的技能」，调用过的一份都省不掉。
