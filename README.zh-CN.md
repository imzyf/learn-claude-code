# Learn Claude Code (TypeScript)

> Harness Engineering for Real Agents.

[English](./README.md) | [中文](./README.zh-CN.md)

[shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)（原版为 Python）的 **TypeScript 移植版**。它一步一步重建 Claude Code 的内部实现。

## 快速开始

```sh
make setup      # 安装依赖，并从 .env.example.upstream 生成 .env
# 然后把 ANTHROPIC_API_KEY 填进 .env（MODEL_ID / ANTHROPIC_BASE_URL 可选）
make smoke      # 发一次 API 调用，检查环境是否配好
make s01        # 运行第 1 课（交互式）；make help 会列出 s01–s20
```

## 亮点

### 架构 🏗️

- 依赖由 **pnpm** 在仓库根目录统一管理。LLM 调用走官方的 **`@anthropic-ai/sdk`**。
- 公共辅助代码放在 `lib/`。
- `bin/sync-upstream.sh`（通过 `make sync` 调用）从上游拉取最新的 Python 参考源码。你的 TS 移植代码不会被改动，所以 `git diff` 能准确显示下一步要移植什么。

### 可观测性 👀

- 每次运行都会在该课的 `sXX/.log/` 下写入一对带时间戳的文件。多次运行不会互相覆盖。
- `*.json` —— 原始的 API 请求/响应流，已格式化。
- `*.log` —— 给人看的对话记录。包含 config / user / assistant / tool-result 各段落，以及每次调用的 token 用量。
- 成本：价格在启动时从 LiteLLM 价格表异步加载一次。

### 可测试性 🧪

- **Vitest**（`make test`）—— 快、免费、不需要任何凭证。它从不调用真实的 Claude API。
- 用 **Dependency injection**，而不是 mock 模块。`agentLoop(messages, { client, logger })` 在测试里接收假对象，在运行时接收真实实现。
- 入口文件上有 `import.meta.main` 守卫。所以测试中 import `main.ts` 不会启动 REPL，也不会写日志文件。
