# Learn Claude Code (TypeScript)

> Harness Engineering for Real Agents.

A **TypeScript port** of [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) (originally Python), rebuilding Claude Code's internals step by step.

## Setup

Dependencies are managed with **pnpm** at the repo root; scripts live in the session directories (`s01_agent_loop/`, `s02_tool_use/`, ... `s20_comprehensive/`) and are run with **tsx**.

LLM calls go through the **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`).

Shared helpers live in `lib/` — `lib/model.ts` builds the AI SDK model from `.env` (supports the Anthropic-compatible providers listed in `.env.upstream`).

```sh
make setup              # pnpm install + create .env from .env.upstream
# then fill in ANTHROPIC_API_KEY (and MODEL_ID / ANTHROPIC_BASE_URL)
make smoke              # one-shot API call to verify the setup
```

## Usage

```sh
make s01                          # run a session (make s01 ... make s20); make help lists them all
```
