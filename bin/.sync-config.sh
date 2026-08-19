#!/usr/bin/env bash
#
# bin/sync-upstream.sh 的共享配置（被 source 引入，而非执行）。

# 按需修改以下变量以匹配你的上游仓库。
UPSTREAM_REPO="https://github.com/shareAI-lab/learn-claude-code.git"
UPSTREAM_BRANCH="main"

# 从上游镜像的目录（仅刷新上游拥有的条目，本地新增文件保留）。
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
  s10_task_system
  s11_background_tasks
  s12_cron_scheduler
  s13_agent_teams
  s14_mcp_plugin
  s15_integrated_harness
  s16_workflow_runtime
  s17_goal_loop
  skills
)

# 要从上游拉取的独立文件。格式 "上游路径" 或 "上游路径:本地路径"（改名落地）。
SYNC_FILES=(
  ".env.example:.env.example.upstream"
  "README-zh.md:README-zh.upstream.md"
  requirements.txt
)

# 从同步中排除的本地化文件（rsync --exclude）。
EXCLUDE_GLOBS=(
  'README.md'
  '*.ja.md'
  '*.en.svg'
  '*.ja.svg'
)
