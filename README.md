# Learn Claude Code (TypeScript)

> Harness Engineering for Real Agents.

A **TypeScript port** of [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) (originally Python), rebuilding Claude Code's internals step by step.

[shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)（原版为 Python）的 **TypeScript 移植版**，一步步重建 Claude Code 的内部机制。

## Setup

Dependencies are managed with **pnpm** at the repo root; scripts live in the session directories (`s01_agent_loop/`, `s02_tool_use/`, ... `s20_comprehensive/`) and are run with **tsx**.

依赖统一由仓库根目录的 **pnpm** 管理；脚本位于各 session 目录（`s01_agent_loop/`、`s02_tool_use/`、…、`s20_comprehensive/`），通过 **tsx** 运行。

LLM calls go through the official **`@anthropic-ai/sdk`**.

Shared helpers live in `lib/`:

- `lib/model.ts` builds the Anthropic client from `.env` (supports the Anthropic-compatible providers listed in `.env.upstream`).

  `lib/model.ts` 从 `.env` 构建 Anthropic client（支持 `.env.upstream` 中列出的 Anthropic 兼容 provider）。

- `lib/tools.ts` — `zodTool()` converts a Zod schema into a Claude API tool definition (JSON Schema `input_schema`); `textOf()` joins all text blocks of a response into one string.

  `lib/tools.ts` — `zodTool()` 把 Zod schema 转换成 Claude API 的工具定义（JSON Schema `input_schema`）；`textOf()` 把响应中的所有文本块拼接成一个字符串。

- `lib/logger.ts` writes a pair of log files under `logs/` (git-ignored) for each run:

  `lib/logger.ts` 每次运行会在 `logs/`（已 git-ignore）下写一对日志文件：

  - `*.json` — raw API request/response stream (pretty-printed, `jq`-friendly); requests only record messages added since the last call, so the file doesn't grow quadratically.

    `*.json` — 原始 API 请求/响应流（pretty-printed，方便用 `jq` 查看）；请求只记录相比上次调用新增的 messages，避免文件平方级膨胀。

  - `*.log` — human-readable transcript (config, user input, assistant turns, tool results), with per-call token usage (including cache write/read) and cost in RMB (per call and running total). Prices are fetched once at startup from the LiteLLM model catalog; if the fetch fails, cost is simply omitted.

    `*.log` — 人类可读的会话记录（配置、用户输入、assistant 回合、工具结果），并带有每次调用的 token 用量（含 cache 写入/读取）和人民币成本（单次及累计）。价格在启动时从 LiteLLM 模型目录获取一次；获取失败则直接省略成本信息。

```sh
make setup      # pnpm install + create .env from .env.upstream
# then fill in ANTHROPIC_API_KEY (and MODEL_ID / ANTHROPIC_BASE_URL)
make smoke      # one-shot API call to verify the setup
```

## Usage

```sh
make s01      # run a session (make s01 ... make s20); make help lists them all
```
