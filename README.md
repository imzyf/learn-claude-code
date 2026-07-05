# Learn Claude Code (TypeScript)

> Harness Engineering for Real Agents.

A **TypeScript port** of [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) (originally Python), rebuilding Claude Code's internals step by step.

[shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)（原版为 Python）的 **TypeScript 移植版**，一步步重建 Claude Code 的内部机制。

## Quick Start

```sh
make setup      # pnpm install + create .env from .env.upstream
# then fill in ANTHROPIC_API_KEY in .env (MODEL_ID / ANTHROPIC_BASE_URL are optional)
make smoke      # one-shot API call to verify the setup
make s01        # run the first session (interactive); make help lists s01–s20
```

## Highlights

### Architecture / 架构

- Dependencies are managed with **pnpm** at the repo root; LLM calls go through the official **`@anthropic-ai/sdk`**.

   依赖在仓库根目录用 **pnpm** 管理；LLM 调用走官方 **`@anthropic-ai/sdk`**。

- Shared helpers in `lib/`: `model.ts` (client + `MODEL_ID` + the `ModelClient` interface), `tools.ts` (`zodTool` turns a Zod schema into a tool definition, `textOf` joins text blocks), `logger.ts`, `pricing.ts`, `testing.ts`.

   `lib/` 里的共享工具：`model.ts`（client + `MODEL_ID` + `ModelClient` 接口）、`tools.ts`（`zodTool` 把 Zod schema 转成工具定义，`textOf` 拼接 text block）、`logger.ts`、`pricing.ts`、`testing.ts`。

- `bin/sync-upstream.sh` (via `make sync` / `make sync-force`) refreshes the Python reference sources from upstream, so your TS ports are untouched and `git diff` shows exactly what to migrate. `bin/.sync-config.sh` holds the sync list.

   `bin/sync-upstream.sh`（通过 `make sync` / `make sync-force`）从上游刷新 Python 参考源码，你的 TS 移植不受影响，`git diff` 正好显示需要迁移的内容。`bin/.sync-config.sh` 保存同步清单。

### Observability / 可观测性

- Each run writes a timestamped pair of files under the session's `sXX/.log/`, so runs never overwrite each other.

  每次运行在对应 session 的 `sXX/.log/` 下写一对带时间戳的文件，运行之间互不覆盖。

- `*.json.log` — the raw API request/response stream, pretty-printed and `jq`-friendly; requests are logged **incrementally** (only messages added since the last call), so the file never grows quadratically with turn count.

   `*.json.log` — 原始 API 请求/响应流，pretty-print 且方便用 `jq` 查看；请求**增量记录**（只记相比上次调用新增的 messages），避免文件随轮数平方级膨胀。

- `*.log` — a human-readable transcript (config / user / assistant / tool result sections), with per-call token usage (including cache write/read) and cost in RMB (per call and running total).

   `*.log` — 人类可读的会话记录（config / user / assistant / tool result 分节），带每次调用的 token 用量（含 cache 写/读）和人民币成本（单次及累计）。

- Cost: prices are fetched once at startup from the LiteLLM catalog (async); four-part pricing (uncached input / cache write / cache read / output); if the fetch fails, cost is simply omitted — logging never breaks the session.

   成本：启动时从 LiteLLM 目录异步取价一次；四段计价（未缓存输入 / 缓存写 / 缓存读 / 输出）；取价失败则直接省略成本——日志功能永不阻断 session。

### Testability / 可测试性

- **Vitest** (`pnpm test` / `pnpm test:watch`) — fast, free, no credentials; the real Claude API is never called.

   **Vitest**（`pnpm test` / `pnpm test:watch`）——快、免费、无需凭证；不调用真实 Claude API。

- **Dependency injection** instead of module mocking: `agentLoop(messages, { client, logger })` takes fakes in tests and the real implementations at runtime, so the mechanism stays visible in the code.

   **依赖注入**而非模块 mock：`agentLoop(messages, { client, logger })` 在测试里传入 fake、运行时传真实实现，机制在代码里始终可见。

- An `import.meta.main` guard on the entry point: importing `main.ts` from a test never starts the REPL or writes log files.

   入口用 `import.meta.main` 守卫：从测试 import `main.ts` 不会启动 REPL、也不写日志文件。
