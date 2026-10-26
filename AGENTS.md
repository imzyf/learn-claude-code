# AGENTS.md

## 项目定位

- 本仓库是 [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) 的 TypeScript 移植版。保留 Python 原版的教学结构和行为，让章节保持简单、可读、渐进。
- 上游拥有的文件不要手改：各章的 `code.py`、`upstream.README.zh.md`、`images/`，以及 `skills/`、`.github/upstream.README-zh.md`、`.upstream.env.example`、`requirements.txt`。通过 `make sync` 同步，范围与映射由 `.github/scripts/.sync-config.sh` 定义。

## 目录约定

- 各章的 `README.md` 是需要真实 API 的人工验证清单。
- 章节特有逻辑留在本章；跨章节稳定、重复的 TypeScript 代码提取到 `lib/` 复用。

## 修改原则

- 新增终端输出遵循 `lib/terminal.ts` 顶部的全项目配色约定。
- 可执行入口保留 `import.meta.main` 守卫，避免导入模块时启动 REPL 或产生日志。

## 测试

- 测试使用 fake client，不调用真实模型 API，也不依赖 `.env`。
- `lib/testing.ts` 只允许被 `*.test.ts` 引用。
- 测试写文件时使用 `makeTempDir` / `useTempDir`：工具以 `process.cwd()` 为根，临时目录必须建在仓库内的 `.tmp/` 下。

## 验证

```sh
make test
pnpm typecheck
make fmt
```
