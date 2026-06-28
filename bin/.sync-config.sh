#!/usr/bin/env bash
#
# Shared config for bin/sync-upstream.sh.
# Sourced, not executed.

# Upstream is the Python reference project; this repo is its TypeScript port.
UPSTREAM_REPO="https://github.com/shareAI-lab/learn-claude-code.git"
UPSTREAM_BRANCH="main"

# Directories to mirror from upstream.
#
# Only the upstream-owned entries inside each dir are refreshed
# (code.py, README*.md, images/). Files you add alongside them for the
# TS port (code.ts, index.ts, ...) are NOT touched or deleted, because
# they do not exist upstream. See sync-upstream.sh for the exact logic.
SYNC_DIRS=(
  s01_agent_loop
  s02_tool_use
)

# Standalone files mirrored from upstream to the SAME path here (overwritten
# in place). Leave empty if every synced file needs renaming (see below).
SYNC_FILES=()

# Files renamed on the way in: "upstream-path:local-path", both relative to
# the repo root. Use this when a file must live under a different name here
# (e.g. keep upstream's reference files without shadowing our own).
SYNC_RENAMES=(
  "README-zh.md:README-upstream.md"
  ".env.example:.env.upstream"
)

# Localized files to delete from SYNC_DIRS after each sync. We keep only the
# Chinese base files (README.md, *.svg); the English (.en) and Japanese (.ja)
# variants are pruned. Upstream uses "ja", not "jp".
PRUNE_GLOBS=(
  '*.en.md'
  '*.ja.md'
  '*.en.svg'
  '*.ja.svg'
)
