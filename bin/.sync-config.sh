#!/usr/bin/env bash
#
# bin/sync-upstream.sh 的共享配置。
# 被 source（引入）而不是执行。

# 上游是 Python 参考项目；这个项目是它的 TypeScript 端口。
UPSTREAM_REPO="https://github.com/shareAI-lab/learn-claude-code.git"
UPSTREAM_BRANCH="main"

# 从上游镜像的目录。
#
# 仅刷新每个目录内的上游拥有的条目
# （code.py、README*.md、images/）。你为 TS 端口在旁边添加的文件
# （code.ts、index.ts 等）不会被触碰或删除，因为它们在上游不存在。
# 有关确切的逻辑，请参阅 sync-upstream.sh。
SYNC_DIRS=(
  s01_agent_loop
  s02_tool_use
  s03_permission
  s04_hooks
  s05_todo_write
  s06_subagent
  s07_skill_loading
  s08_context_compact
  s09_memory
  s10_system_prompt
  s11_error_recovery
  s12_task_system
  s13_background_tasks
  s14_cron_scheduler
  s15_agent_teams
  s16_team_protocols
  s17_autonomous_agents
  s18_worktree_isolation
  s19_mcp_plugin
  s20_comprehensive
  skills
)

# 要从上游拉取的独立文件（也决定 sparse-checkout 范围）。每项是
# "上游路径" 或 "上游路径:本地路径"；省略 ":本地路径" 时镜像到
# 此处相同路径，写了则改名落地（例如避免与我们自己的 .env 冲突）。
SYNC_FILES=(
  "requirements.txt"
  "README-zh.md:README-zh.upstream.md"
  ".env.example:.env.example.upstream"
)

# 从同步中排除的本地化文件（传递给 rsync --exclude）。我们仅保留中文基础
# 文件（README.md、*.svg）；英文（.en）和日文（.ja）变体被跳过。
# 上游使用"ja"而不是"jp"。
EXCLUDE_GLOBS=(
  '*.en.md'
  '*.ja.md'
  '*.en.svg'
  '*.ja.svg'
)
