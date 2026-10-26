---
name: chapter-readme
description: "Write a chapter README in this repo: sXX_*/README.md, whose main content is the 手动验证清单, the prompts a reader pastes into the REPL to see the chapter mechanism work against a real model API. Use when adding a README for a new chapter, or updating one after the chapter source changed. Not for writing main.test.ts cases."
---

章节 README（`sXX_*/README.md`）以手动验证清单为主体，让读者在 REPL 中粘贴 prompt，亲手观察本章新增机制的终端输出、hook 时序、落盘产物和模型反应。读者懂代码、会翻日志，只需指出关键现象和查看位置。

写清单时不调用真实 API，实际运行由读者完成。覆盖范围按本章机制确定，不以 `main.test.ts` 是否覆盖为依据。正文用中文，prompt 原文、日志文案和标识符保持原样；成品样式参考 `s01_agent_loop/README.md`。

## 工作步骤

1. 确定本章新增或改动的路径。新建时比较本章与上一章的 `main.ts`；补充时查看本次源码的 `git diff`，列出受影响的小节。用上游 `code.py`、`upstream.README.zh.md` 对照教学意图。完成后，应能用一到三句说清相对上一章或改动前多了什么。
2. 沿路径列出正常分支、错误分支、边界（如最新一轮不动、短输入不动、达标即停），以及主链外的入口（如模型主动调用工具、异常时的应急重试）。每条分支要么纳入小节，要么按下一步排除。
3. 排除与本章机制无关且无可观察输出的分支，以及需要等待几分钟或难以构造条件的分支。每条保留项都要能说明让读者看见本章的哪一点；排除项不写进正文。
4. 为每节设计 prompt，沿 `main.ts` 和 `lib/` 推导可观察结果，尤其核对 `lib/logger.ts`、`lib/tools.ts` 中的输出字面量。固定文案必须有源码依据，可变或无法确定的值用占位符，不编造。正文只描述观察结果，不标注源码文件或行号。
5. 按下述格式逐条复核并修正。补充已有清单时，也核对未受改动影响小节的输出字面量。

## 清单格式

### 结构

- 开头只含标题、`本章的机制：` 一段和启动命令；机制段用一到三句说明新增路径，命令块不写注释。
- 一章 4 到 7 节。标题用断言直接点明具体行为、分支或条件，不用「验证 X」「检查 X」或「一句话跑遍 X」等概括。
- 最后一节写完即结束，不加补充说明、覆盖范围、清理步骤或总结。

### Prompt

- 每节一到两条，每条一行原文、一行中文翻译，原文不以标点结尾。同一 session 连续发送的多条放在同一个 `prompt` 块中，各组原文与翻译之间空一行。
- 路径以启动命令的实际工作目录为准。从仓库根目录运行 `pnpm dev sXX_<name>/main.ts` 时，章节内文件须带 `sXX_<name>/` 前缀。
- 结果依赖模型自由发挥时（如可能把工具调用拆成多轮），用一句话说明如何重试。

### 观察判据

- 用一到两句散文说明期望现象及其体现的机制，每节点出一两个关键点即可；不用「看到 X 算过」的判分口吻，不复述显而易见的细节。
- 需要展示输出时，用 `plaintext` 块只放能一眼对上的关键行，省略处写 `...`，可变值写 `<N>`、`<trace>`、`<模型的最终回答>` 等占位符，不抄整屏。第二条 prompt 仅为同一判据的反面时，用散文说明即可，不必另配输出块。
- 日志判据用一句话指明本次运行的文件和小节，例如「判据在 `_transcript.log` 的 `REQUEST` 小节」。不逐节罗列日志内容或抄记录格式，不提供 `grep`、`find`、`tail` 命令，也不要求保存 shell 变量。
- 除启动命令外，不出现 shell 块。

## 骨架

以下 `plaintext` 块按需保留。

````markdown
# sXX: <机制名> 手动验证清单

本章的机制：<一到三句，说清相对上一章新增的路径>。

```sh
pnpm dev sXX_<name>/main.ts
```

## 1. <直接断言具体行为的标题>

```prompt
<英文 prompt 原文，无结尾标点>
<中文翻译>
```

<期望现象、查看位置及其体现的机制>。

```plaintext
<关键输出，可变值用占位符>
```
````
