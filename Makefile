.PHONY: help setup sync sync-force smoke test test-watch typecheck lint lint-check \
	s01 s02 s03 s04 s05 s06 s07 s08 s09 s10 \
	s11 s12 s13 s14 s15 s16 s17 s18 s19 s20

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} \
		/^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next} \
		/^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' \
		$(MAKEFILE_LIST)

##@ Setup

setup: ## Install deps and create .env from .env.example.upstream
	pnpm install
	[ -f .env ] || cp .env.example.upstream .env

smoke: ## One-shot API call to verify the setup
	pnpm smoke

##@ Checks

test: ## Run the test suite once
	pnpm test

test-watch: ## Run the test suite in watch mode
	pnpm test:watch

typecheck: ## Type-check without emitting
	pnpm typecheck

lint: ## Lint and auto-fix with Biome
	pnpm lint:fix

lint-check: ## Check lint and formatting without writing (used by CI)
	pnpm lint

##@ Sync

sync: ## Sync Python reference sources from upstream (cached)
	bin/sync-upstream.sh

sync-force: ## Sync from upstream, ignoring the clone cache
	LCC_SYNC_CACHE_TTL=0 bin/sync-upstream.sh

##@ Sessions

s01: ## Run s01 agent loop (interactive)
	pnpm dev s01_agent_loop/main.ts

s02: ## Run s02 tool use (interactive)
	pnpm dev s02_tool_use/main.ts

s03: ## Run s03 permission system (interactive)
	pnpm dev s03_permission/main.ts

s04: ## Run s04 hooks (interactive)
	pnpm dev s04_hooks/main.ts

s05: ## Run s05 todo write (interactive)
	pnpm dev s05_todo_write/main.ts

s06: ## Run s06 subagent (interactive)
	pnpm dev s06_subagent/main.ts

s07: ## Run s07 skill loading (interactive)
	pnpm dev s07_skill_loading/main.ts

s08: ## Run s08 context compaction (interactive)
	pnpm dev s08_context_compact/main.ts

s09: ## Run s09 memory (interactive)
	pnpm dev s09_memory/main.ts

s10: ## Run s10 system prompt (interactive)
	pnpm dev s10_system_prompt/main.ts

s11: ## Run s11 error recovery (interactive)
	pnpm dev s11_error_recovery/main.ts

s12: ## Run s12 task system (interactive)
	pnpm dev s12_task_system/main.ts

s13: ## Run s13 background tasks (interactive)
	pnpm dev s13_background_tasks/main.ts

s14: ## Run s14 cron scheduler (interactive)
	pnpm dev s14_cron_scheduler/main.ts

s15: ## Run s15 agent teams (interactive)
	pnpm dev s15_agent_teams/main.ts

s16: ## Run s16 team protocols (interactive)
	pnpm dev s16_team_protocols/main.ts

s17: ## Run s17 autonomous agents (interactive)
	pnpm dev s17_autonomous_agents/main.ts

s18: ## Run s18 worktree isolation (interactive)
	pnpm dev s18_worktree_isolation/main.ts

s19: ## Run s19 MCP plugin (interactive)
	pnpm dev s19_mcp_plugin/main.ts

s20: ## Run s20 comprehensive (interactive)
	pnpm dev s20_comprehensive/main.ts
