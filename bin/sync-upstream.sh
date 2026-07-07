#!/usr/bin/env bash
#
# 从上游 shareAI-lab/learn-claude-code 同步 Python 参考源文件到这个项目
# 该项目是上游项目的 TypeScript 版本
#
# 对于 SYNC_DIRS 中的每个目录（见 .sync-config.sh），上游拥有的文件
# （code.py、README*.md、images/）会被刷新到原位置。你在旁边写的 TS 文件
# （code.ts 等）不会被触碰，这样你可以保持 Python 参考在你的端口旁边，
# 并且每次同步后可以用 `git diff` 看到上游的更改，然后手动移植。
#
# 上游的克隆是稀疏的（仅限 SYNC_DIRS + SYNC_FILES），并在 CACHE_DIR 下
# 被缓存 CACHE_TTL_SECONDS（默认 1 天），所以同一天重新运行会重用它。
# 删除 CACHE_DIR 或设置 LCC_SYNC_CACHE_TTL=0 来强制重新克隆。
#
# 使用方法：bin/sync-upstream.sh
#
# 环境变量覆盖：
#   LCC_SYNC_CACHE_DIR   缓存的上游克隆的位置
#   LCC_SYNC_CACHE_TTL   缓存生命周期（秒）(0 = 始终重新克隆)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(dirname "${SCRIPT_DIR}")"
source "${SCRIPT_DIR}/.sync-config.sh"

CACHE_DIR="${LCC_SYNC_CACHE_DIR:-${SCRIPT_DIR}/.cache/learn-claude-code-upstream}"
CACHE_TTL_SECONDS="${LCC_SYNC_CACHE_TTL:-86400}"
CACHE_MARKER="${CACHE_DIR}.last-clone"
clone_dir="${CACHE_DIR}"

cache_is_fresh() {
  [[ -d "${clone_dir}/.git" && -f "${CACHE_MARKER}" ]] || return 1
  local age=$(( $(date +%s) - $(cat "${CACHE_MARKER}") ))
  (( age < CACHE_TTL_SECONDS ))
}

if cache_is_fresh; then
  echo "==> Reusing cached clone at ${clone_dir} (younger than ${CACHE_TTL_SECONDS}s)"
else
  # 每个我们想要检出的路径：同步目录和独立文件（取 SYNC_FILES 条目
  # ":" 前的上游路径部分）。受保护，以便空数组在 -u 下是安全的。
  sparse_paths=()
  for p in "${SYNC_DIRS[@]:-}" "${SYNC_FILES[@]:-}"; do
    [[ -n "${p}" ]] && sparse_paths+=( "/${p%%:*}" )
  done
  echo "==> Cloning ${UPSTREAM_REPO} (${UPSTREAM_BRANCH}: ${sparse_paths[*]#/})"
  rm -rf "${clone_dir}"
  mkdir -p "${clone_dir}"
  git clone --depth=1 --filter=blob:none --sparse -q \
    --branch "${UPSTREAM_BRANCH}" "${UPSTREAM_REPO}" "${clone_dir}"
  git -C "${clone_dir}" sparse-checkout set --no-cone "${sparse_paths[@]}"
  date +%s > "${CACHE_MARKER}"
fi

shopt -s dotglob

# rsync 排除我们不想复制的本地化变体。rsync 即使在匹配是字面源参数时
# 也会跳过（不仅仅在递归期间），所以这个方法同时覆盖顶级文件
# （README.en.md）和嵌套文件（images/*.en.svg）—— 不需要单独的 bash glob 匹配。
exclude_args=()
for glob in "${EXCLUDE_GLOBS[@]:-}"; do
  [[ -n "${glob}" ]] && exclude_args+=( --exclude="${glob}" )
done

for dir in "${SYNC_DIRS[@]}"; do
  src="${clone_dir}/${dir}"
  if [[ ! -d "${src}" ]]; then
    echo "!! Skipping ${dir} (not found upstream)"
    continue
  fi
  echo "==> Refreshing upstream files in ${dir}/ (TS files preserved)"
  mkdir -p "${ROOT_DIR}/${dir}"
  # 刷新原位置上游拥有的每个条目。仅存在于本地的条目
  # （你的 code.ts 等）永远不会被触碰。
  for entry in "${src}"/*; do
    name="$(basename "${entry}")"
    rm -rf "${ROOT_DIR:?}/${dir}/${name}"
    # -q：排除的顶级条目（例如 README.en.md）是预期的且无声的；
    # rsync 否则会为其警告"跳过排除的文件"。
    rsync -aq "${exclude_args[@]}" "${entry}" "${ROOT_DIR}/${dir}/"
    echo "  - ${dir}/${name}"
  done
done

# 每项是 "上游路径" 或 "上游路径:本地路径"；没有 ":" 时源和目标
# 路径相同（原样镜像），写了 ":" 则改名落地。
for entry in "${SYNC_FILES[@]:-}"; do
  [[ -n "${entry}" ]] || continue
  src_rel="${entry%%:*}"
  dest_rel="${entry#*:}"
  src="${clone_dir}/${src_rel}"
  if [[ ! -f "${src}" ]]; then
    echo "!! Skipping ${src_rel} (not found upstream)"
    continue
  fi
  if [[ "${src_rel}" == "${dest_rel}" ]]; then
    echo "==> Mirroring ${src_rel}"
  else
    echo "==> Mirroring ${src_rel} -> ${dest_rel}"
  fi
  mkdir -p "$(dirname "${ROOT_DIR}/${dest_rel}")"
  cp "${src}" "${ROOT_DIR}/${dest_rel}"
done

echo "==> Done. Review upstream changes with: git diff"
