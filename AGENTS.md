# AGENTS.md

## 项目定位

- 本仓库是 `learn-claude-code` 的 TypeScript 移植版，课程按 `s01`–`s17` 逐步演进。
- `main.ts` 是 TypeScript 实现；各章的 `code.py` 和 `README.zh.md` 来自上游，除非任务明确要求，否则不要修改。
- 公共能力放在 `lib/`；章节特有逻辑留在对应的 `sXX_*` 目录。

## 修改原则

- 尊重 Python 原版的教学结构和行为，保持章节简单、可读且渐进；跨章节稳定、重复的 TypeScript 代码应提取到 `lib/` 复用。
- 使用严格 TypeScript、ES modules 和 `import type`；格式遵循 Biome（2 空格缩进）。
- 可测试逻辑应通过依赖注入隔离。测试使用 fake client，不调用真实模型 API，也不依赖 `.env`。
- 可执行入口必须保留 `import.meta.main` 守卫，避免导入模块时启动 REPL 或产生日志。

## 验证

```sh
pnpm test
pnpm typecheck
pnpm lint
```

开发单章时，先运行对应的 `*.test.ts`，再按改动范围运行完整检查。
