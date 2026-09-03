.PHONY: help setup sync smoke test lint open-upstream open-repo \
	debug \
	s01 s02 s03 s04 s05 s06 s07 s08 s09 s10 \
	s11 s12 s13 s14 s15 s16 s17

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} \
		/^##@/ {printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next} \
		/^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' \
		$(MAKEFILE_LIST)

##@ Setup

open-upstream: ## Open the upstream repo in the browser
	open https://github.com/shareAI-lab/learn-claude-code

open-repo: ## Open this repo's GitHub page in the browser
	open https://github.com/imzyf/learn-claude-code

setup: ## Install deps and create .env from .upstream.env.example
	pnpm install
	[ -f .env ] || cp .upstream.env.example .env

smoke: ## One-shot API call to verify the setup
	pnpm smoke

##@ Checks

# Remove leftover .tmp/ dirs created by tests (excluding node_modules).
CLEAN_TMP = find . -type d -name .tmp -not -path '*/node_modules/*' -exec rm -rf {} +

test: ## Run the test suite once, then remove leftover .tmp/ dirs
	pnpm test; status=$$?; $(CLEAN_TMP); exit $$status

lint: ## Lint and auto-fix with Biome, then remove leftover .tmp/ dirs
	pnpm lint:fix; status=$$?; $(CLEAN_TMP); exit $$status

##@ Sync

sync: ## Sync Python reference sources from upstream (cached); set LCC_SYNC_CACHE_TTL=0 to ignore the clone cache
	.github/scripts/sync-upstream.sh

##@ Sessions

# `debug` is a command-line modifier, so `make s01 debug` through
# `make s17 debug` start the selected session with Node's inspector.
SESSIONS = s01 s02 s03 s04 s05 s06 s07 s08 s09 s10 \
	s11 s12 s13 s14 s15 s16 s17
ACTIVE_SESSION = $(firstword $(filter $(SESSIONS),$(MAKECMDGOALS)))

SESSION_RUNNER = pnpm dev
SESSION_DEBUG_CHECK = @:
SESSION_DEBUG_HINT = @:
ifneq (,$(filter debug,$(MAKECMDGOALS)))
SESSION_DEBUG_CHECK = @if lsof -nP -iTCP:9229 -sTCP:LISTEN >/dev/null; then \
	echo "Error: debug port 9229 is already in use."; \
	echo "Stop the old debugger, then run 'make $(ACTIVE_SESSION) debug' again."; \
	exit 1; \
fi
SESSION_DEBUG_HINT = @echo "Waiting for VS Code: Run and Debug -> Attach session (make sXX debug)"
SESSION_RUNNER = env -u ANTHROPIC_AUTH_TOKEN node --enable-source-maps --inspect-brk=9229 \
	--env-file-if-exists=.env --import tsx
endif

define RUN_SESSION
$(SESSION_DEBUG_CHECK)
$(SESSION_DEBUG_HINT)
$(SESSION_RUNNER) $(1)
endef

debug: ## Debug modifier; use with `make s01 debug` through `make s20 debug`
	@if [ -z "$(ACTIVE_SESSION)" ]; then \
		echo "Usage: make <s01..s17> debug"; \
	fi

s01: ## Run s01 agent loop
	$(call RUN_SESSION,s01_agent_loop/main.ts)

s02: ## Run s02 tool use
	$(call RUN_SESSION,s02_tool_use/main.ts)

s03: ## Run s03 permission system
	$(call RUN_SESSION,s03_permission/main.ts)

s04: ## Run s04 hooks
	$(call RUN_SESSION,s04_hooks/main.ts)

s05: ## Run s05 todo write
	$(call RUN_SESSION,s05_todo_write/main.ts)

s06: ## Run s06 subagent
	$(call RUN_SESSION,s06_subagent/main.ts)

s07: ## Run s07 skill loading
	$(call RUN_SESSION,s07_skill_loading/main.ts)

s08: ## Run s08 context compaction
	$(call RUN_SESSION,s08_context_compact/main.ts)

s09: ## Run s09 memory
	$(call RUN_SESSION,s09_memory/main.ts)

s10: ## Run s10 task system
	$(call RUN_SESSION,s10_task_system/main.ts)

s11: ## Run s11 background tasks
	$(call RUN_SESSION,s11_background_tasks/main.ts)

s12: ## Run s12 cron scheduler
	$(call RUN_SESSION,s12_cron_scheduler/main.ts)

s13: ## Run s13 agent teams
	$(call RUN_SESSION,s13_agent_teams/main.ts)

s14: ## Run s14 mcp plugin
	$(call RUN_SESSION,s14_mcp_plugin/main.ts)

s15: ## Run s15 integrated harness
	$(call RUN_SESSION,s15_integrated_harness/main.ts)

s16: ## Run s16 workflow runtime
	$(call RUN_SESSION,s16_workflow_runtime/main.ts)

s17: ## Run s17 goal loop
	$(call RUN_SESSION,s17_goal_loop/main.ts)
