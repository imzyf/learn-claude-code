# AGENTS.md

## 项目定位

- 本仓库是 [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) 的 TypeScript 移植版，课程从 `s01` 到 `s17` 逐步演进。
- `main.ts` 是 TypeScript 实现；上游拥有的文件不要改，包括各章的 `code.py`、`README.zh.upstream.md`、`images/`，以及 `skills/`、`README-zh.upstream.md`、`.env.example.upstream`、`requirements.txt`。同步入口是 `make sync`（配置见 `bin/.sync-config.sh`）。
- 公共能力放在 `lib/`；章节特有逻辑留在对应的 `sXX_*` 目录。

## 目录约定

- 每章包含 `main.ts`（可运行入口）、`main.test.ts`（vitest 用例）、`manual-check.md`（需要真实 API 的人工验证清单），其余文件来自上游。
- `lib/` 模块分工：`model.ts` 提供 client 和 `MODEL_ID`，`tools.ts` 定义工具与解析回复，`logger.ts` 写 JSON 与 transcript 双日志，`pricing.ts` 取价计费，`terminal.ts` 管终端上色与提示符，`testing.ts` 只被 `*.test.ts` 引用，提供 fake client 与临时目录工厂。
- `lib/terminal.ts` 顶部的配色约定对全项目生效，新增输出按那套颜色走。

## 修改原则

- 尊重 Python 原版的教学结构和行为，保持章节简单、可读且渐进；跨章节稳定、重复的 TypeScript 代码应提取到 `lib/` 复用。
- 使用严格 TypeScript、ES modules 和 `import type`；格式遵循 Biome（2 空格缩进）。
- 可测试逻辑应通过依赖注入隔离。测试使用 fake client，不调用真实模型 API，也不依赖 `.env`。
- 测试要写文件时，用 `lib/testing.ts` 的 `makeTempDir` / `useTempDir`：工具以 `process.cwd()` 为根，临时目录必须建在仓库内的 `.tmp/` 下。
- 可执行入口必须保留 `import.meta.main` 守卫，避免导入模块时启动 REPL 或产生日志。

## 验证

```sh
make test       # pnpm test，跑完清理残留的 .tmp/
make typecheck  # pnpm typecheck
make lint       # pnpm lint:fix，CI 用不写盘的 make lint-check
```