# Learn Claude Code (TypeScript)

> Harness Engineering for Real Agents.

A **TypeScript port** of [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code) (originally Python). It rebuilds Claude Code's internals, one step at a time.

## Quick Start

```sh
make setup      # install deps, create .env from .env.example.upstream
# then put your ANTHROPIC_API_KEY in .env (MODEL_ID / ANTHROPIC_BASE_URL are optional)
make smoke      # one API call to check the setup
make s01        # run session 1 (interactive); make help lists s01–s20
```

## Highlights

### 🏗️ Architecture

- **pnpm** manages dependencies at the repo root. LLM calls go through the official **`@anthropic-ai/sdk`**.
- Shared helpers live in `lib/`.
- `bin/sync-upstream.sh` (via `make sync`) pulls fresh Python reference sources from upstream. Your TS ports stay untouched, so `git diff` shows exactly what to port next.

### 👀 Observability

- Each run writes a timestamped pair of files under the session's `sXX/.log/`. Runs never overwrite each other.
- `*.json` — the raw API request/response stream, pretty-printed.
- `*.log` — a human-readable transcript. It has config / user / assistant / tool-result sections, and per-call token usage.
- Cost: prices load once at startup from the LiteLLM price list (async).

### 🧪 Testability

- **Vitest** (`make test`) — fast, free, and needs no credentials. It never calls the real Claude API.
- **Dependency injection**, not module mocking. `agentLoop(messages, { client, logger })` takes fakes in tests, and the real code at runtime.
- An `import.meta.main` guard sits on the entry point. So importing `main.ts` from a test never starts the REPL or writes log files.
