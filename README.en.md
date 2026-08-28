<h4 align="right"><a href="./README.md">中文</a> | <strong>English</strong></h4>

# Learn Claude Code (TypeScript)

> Harness Engineering for Real Agents.

A **TypeScript port** of [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code): `s01`-`s17`, each session adding one harness mechanism, rebuilding Claude Code's internals.

## Quick Start

```sh
make setup      # install deps, create .env from .env.example.upstream
# then put your ANTHROPIC_API_KEY in .env (MODEL_ID / ANTHROPIC_BASE_URL are optional)
make smoke      # one API call to check the setup
make s01        # run session 1 (interactive); make help lists s01–s17
make s01 debug  # debug any session from s01 through s17 on port 9229, attach VS Code with the `Attach session (make sXX debug)` launch configuration
```

## Highlights

### Architecture

- **pnpm** manages dependencies at the repo root. LLM calls go through the official **`@anthropic-ai/sdk`**.
- Sync scripts live in `bin/`: `sync-upstream.sh` runs via `make sync` and pulls fresh Python reference sources from upstream; the upstream repo URL, synced directories, and localization excludes are configured in `.sync-config.sh`. Run `git diff` afterward to see the latest upstream changes.
- Shared helpers live in `lib/`: `model.ts` sets up the client and model id, `tools.ts` defines tools and parses replies, `logger.ts` writes logs, `pricing.ts` tracks call cost, `terminal.ts` handles terminal output, `testing.ts` provides test stubs.

### Observability

- Each run writes a pair of files under the session's `sXX/.log/`, filenames start with a sortable timestamp, so runs never overwrite each other.
- `*_api.json` is the raw API request/response stream, pretty-printed; `*_transcript.log` is a human-readable transcript with config / user / assistant / tool-result sections and per-call token usage.
- The model price list loads once at startup from LiteLLM (async), used to compute cost from token usage.

### Testability

- **Vitest** (`make test`) is fast, free, and needs no credentials; it never calls the real Claude API.
- **Dependency injection**, not module mocking: `agentLoop(messages, { client, logger })` takes fakes in tests, the real code at runtime; fakes must satisfy the same type signature as the real client, so a mismatch shows up at compile time.
- An `import.meta.main` guard sits on the entry point, so importing `main.ts` from a test never starts the REPL or writes log files.
- Beyond Vitest, each `sXX_*` directory has a `README.md` with prompts and expected behavior for runs against the real API, covering terminal output and log content that only show up when you actually run the session.

---

*Agency comes from the model. The harness gives agency a place to land. Build the harness well, and the model will do the rest.*

*Bash is all you need. Real agents are all the universe needs.*

*This is not "copy the source code." This is "grasp the key designs and build it yourself."*
