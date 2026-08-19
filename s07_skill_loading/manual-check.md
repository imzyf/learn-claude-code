# s07: Skill Loading 手动验证清单

本章只加了一个机制：两级加载。启动时扫 `skills/*/SKILL.md`，SYSTEM 里只放「名称 + 一行描述」（`main.ts:114-178`）；完整 SKILL.md 要等模型调 `load_skill` 才通过 `tool_result` 进上下文（`main.ts:192-223`）。这份清单验三件事：SYSTEM 里确实只有目录、按需加载真的发生了、扫描与查表的边界在哪。

`main.test.ts` 已用临时目录和内存 registry 覆盖 frontmatter 解析、扫描规则、错误文案和 `load_skill` 分发，手动跑补的是 fake 替不掉的部分：真实模型认不认这份目录、会不会自己挑对技能名、以及 token 账单上「目录便宜、内容贵」这件事看不看得见。

工具分发、权限关卡、hook 机制在 [s02](../s02_tool_use/manual-check.md)、[s03](../s03_permission/manual-check.md)、[s04](../s04_hooks/manual-check.md)、[s05](../s05_todo_write/manual-check.md) 的清单里验过，s07 原样复用（`loadHooks`，`main.ts:344`），这里不重复。s05 的 `todo_write`、s06 的 `task` 都不在本章工具表里（`main.ts:232-240`）。

```sh
# 必须在仓库根目录跑：SKILLS_DIR = process.cwd()/skills（main.ts:63-64）
pnpm dev s07_skill_loading/main.ts
# 另一个终端：文件名以可排序的时间戳开头，取排序后最后一个就是本次运行
tail -f "$(find s07_skill_loading/.log -name '*_transcript.log' | sort | tail -1)"
```

## 1. 启动即写 SKILL CATALOG，一个技能一行

还没输入任何问题时，transcript 的**第一节**就该是 `SKILL CATALOG`（`main.ts:182-186`，早于 `HOOK REGISTER`，因为 `loadSkills` 在 `loadHooks` 之前跑）：

```plaintext
- agent-builder: Design and build AI agents for any domain. Use when users: (1) ask to ...
- code-review: Perform thorough code reviews with security, performance, and maintainability analysis. ...
- mcp-builder: Build MCP (Model Context Protocol) servers that give Claude new capabilities. ...
- pdf: Process PDF files - extract text, create PDFs, merge documents. ...
```

三个观察点：

- 四行，顺序是 `agent-builder` / `code-review` / `mcp-builder` / `pdf`，按目录名的 codepoint 序（`main.ts:118-122`）。
- `agent-builder` 的 `description` 在 SKILL.md 里是多行块标量（`description: |`），这里必须压成**一行**（`collapse`，`main.ts:150-156`）。如果看到它换行了，说明 frontmatter 走的不是 YAML 库那条路。
- 从别的目录启动（比如 `cd s07_skill_loading && pnpm dev ...`）会得到 `(no skills found)`，这不是 bug，是 `SKILLS_DIR` 跟着 `process.cwd()` 走。

接着看 `.log/*_api.json` 的第一条 `config`（`main.ts:342`）：`tools` 是 6 个（s02 的 5 个基础工具加一个 `load_skill`），`system` 字段里只有上面那四行描述，**不含**任何一份 SKILL.md 正文。这就是本章的全部主张，其余步骤都在验证它成立。

## 2. 按需加载：目录里的一行 vs 四千字符的正文

- `Use the code-review skill to review the last commit.`

期望顺序：

1. `🔧 load_skill({"name":"code-review"})`（青）
2. transcript 里一节 `SKILL`：`load code-review (4266 chars)`（`main.ts:203-213`）
3. transcript 里一节 `TOOL RESULT (load_skill)`：完整的 SKILL.md 正文
4. 模型按 SKILL.md 里的流程开始跑 `bash git log` 之类的工具

第 2 和第 3 节是两条记录同一件事的不同粒度：`SKILL` 是给人扫读和 grep 的一行摘要，`TOOL RESULT` 是模型实际收到的那份内容。字符数应该和 `wc -c skills/code-review/SKILL.md` 对得上。

隐藏成本在这里显形：对照 `.log/*_api.json`，第一次 `api_request` 的 `chars` 只有目录那点量，`load_skill` 之后那一次会多出四千多字符，并且**此后每一轮都带着它**。这正是「目录进 SYSTEM、内容按需加载」要省的东西——没被调用的三个技能，一个字符都没进过上下文。

## 3. 模型挑错名字时能自己纠正

- `Load the skill called pdf-tools and tell me what it does.`

目录里叫 `pdf`，不叫 `pdf-tools`。预期 `tool_result` 是：

```plaintext
Error: Unknown skill 'pdf-tools'. Available: agent-builder, code-review, mcp-builder, pdf
```

（`main.ts:192-196`；transcript 里对应 `SKILL` 一节的 `not found: pdf-tools`。）把可选名字一并回给模型，就是为了让它下一轮直接改用 `pdf`——通常一轮就纠正过来了。这条也是「查表而非路径拼接」的体现：`loadSkill` 从头到尾没做过 `path.join`，所以 `name` 里塞 `../../etc/passwd` 同样只会撞上这句 `Unknown skill`，不需要额外的路径校验。

## 4. 不点名技能时，模型自己挑得中吗

前三节都在 prompt 里直接报了技能名，这节反过来——只描述任务，看模型会不会自己从目录里认出该用哪个：

- `I need a server that lets Claude query our internal ticket system. Set it up.`（期望 `mcp-builder`）
- `Look at the diff in the working tree and tell me what's risky.`（期望 `code-review`）

这是 `description` 那一行唯一的验收标准。四份 SKILL.md 的 description 都是「一句功能 + `Use when user asks to ...`」的写法，后半句就是给模型做匹配用的。判定看两点：第一个工具调用是不是 `load_skill`，以及挑的名字对不对。

挑不中的话，先别改代码——目录是什么样，模型看到的就是什么样，在 `SKILL CATALOG` 那一节里读一遍：如果一个技能的描述被截在半截、或者只剩一个泛泛的标题（说明它走了「正文首行」那条回退路径，`main.ts:140-142`），那就是描述本身没写出触发条件，不是加载机制的问题。

顺带一个对照：目录只影响模型「挑不挑」，不影响「能不能调」。哪怕它完全没提技能直接开干，`load_skill` 也一直在工具表里，你在下一轮明说技能名，它照样能加载。

## 5. 加载进来的内容真的改变了行为吗

同一个任务问两遍，中间用 `q` 退出重开（换新会话，`history` 清空）：

1. 第一遍：`Review lib/logger.ts.` —— 如果模型没调 `load_skill` 就直接答，记下它的回答结构。
2. 第二遍：`Use the code-review skill to review lib/logger.ts.`

第二遍的回答应该贴着 `skills/code-review/SKILL.md` 的 `Review Output Format` 一节走，那里写死了五个标题：

```plaintext
### Summary
### Critical Issues
### Improvements
### Positive Notes
### Verdict
```

这几个词是现成的判定依据：出现了就说明 SKILL.md 真的在指挥输出，没出现就是没生效。「加载」这件事唯一能被感知的效果就在这里——SKILL.md 不是知识库，是一段临时接进上下文的操作指令，模型的输出格式跟着它变。

看不出差别时，去 transcript 的 `TOOL RESULT (load_skill)` 一节确认内容确实完整进去了（结尾没被截断）。内容进去了但输出没变，那是模型没遵循，属于模型行为；内容压根没进去，才是本章的 bug。

## 6. 一次加载，整段会话都在付费

接着第 5 步的会话继续追问，别退出：

- `Now review lib/terminal.ts too.`

期望模型**不再**调 `load_skill`——SKILL.md 已经在 `history` 里了，重复加载只是把同一份四千字符再塞一遍。transcript 里应该只有一节 `SKILL`，不是两节。

真出现第二节 `SKILL`（同一个技能名）时，看 `.log/*_api.json` 里那一轮的请求：两份完全相同的正文并排躺在 messages 里，`chars` 也翻倍。这不是错误，`load_skill` 本来就是无状态查表、调几次给几次（`main.ts:192-196`），但它说明了 s08 要解决的问题——上下文只增不减，重复内容也一样占额度。

同一会话里换个不相干的技能（`Now use the pdf skill to ...`）则应该正常触发一次新的加载，两份内容此后一直共存在上下文里。这也是本章的取舍：省的是「没被调用的技能」，调用过的一份都省不掉。
