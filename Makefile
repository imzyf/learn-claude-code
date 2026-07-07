.PHONY: help sync sync-force smoke s01

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

sync: ## Sync Python reference sources from upstream (cached)
	bin/sync-upstream.sh

sync-force: ## Sync from upstream, ignoring the clone cache
	LCC_SYNC_CACHE_TTL=0 bin/sync-upstream.sh

smoke: ## One-shot API call to verify the setup
	pnpm smoke

s01: ## Run s01 agent loop (interactive)
	pnpm dev s01_agent_loop/main.ts
