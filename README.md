# Learn Claude Code - Harness Engineering for Real Agents (TypeScript)

A **TypeScript port** of [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)
(originally Python), rebuilding Claude Code's internals step by step.

## Setup

Dependencies are managed with **pnpm** at the repo root; scripts live in the
session directories (`s01_agent_loop/`, `s02_tool_use/`, ...) and are run with
**tsx**. LLM calls go through the **Vercel AI SDK** (`ai` + `@ai-sdk/anthropic`).

```sh
pnpm install
cp .env.upstream .env   # then fill in ANTHROPIC_API_KEY (and MODEL_ID / ANTHROPIC_BASE_URL)
pnpm smoke              # one-shot API call to verify the setup
```

## Usage

```sh
pnpm dev s01_agent_loop/main.ts   # run any script with .env loaded
pnpm typecheck                    # tsc --noEmit over the whole repo
```

Shared helpers live in `lib/` — `lib/model.ts` builds the AI SDK model from
`.env` (supports the Anthropic-compatible providers listed in `.env.upstream`).
