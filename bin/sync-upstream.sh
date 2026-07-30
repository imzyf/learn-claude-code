#!/usr/bin/env bash
#
# 从上游仓库（配置见 .sync-config.sh）同步文件到本项目。
#
# SYNC_DIRS 中每个目录只刷新上游拥有的文件，本地新增文件保留，
# 同步后可用 `git diff` 查看上游更改并手动移植。
#
# 上游是稀疏克隆（仅 SYNC_DIRS + SYNC_FILES），缓存于 CACHE_DIR，
# 有效期 CACHE_TTL_SECONDS（默认 1 天）；删 CACHE_DIR 或设
# LCC_SYNC_CACHE_TTL=0 强制重新克隆。
#
# 用法：bin/sync-upstream.sh
# 环境变量：
#   LCC_SYNC_CACHE_DIR   缓存克隆的位置
#   LCC_SYNC_CACHE_TTL   缓存有效期（秒，0 = 始终重新克隆）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT_DIR="$(dirname "${SCRIPT_DIR}")"
source "${SCRIPT_DIR}/.sync-config.sh"

CACHE_DIR="${LCC_SYNC_CACHE_DIR:-${SCRIPT_DIR}/.cache/upstream}"
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
  # 要检出的路径：SYNC_DIRS + SYNC_FILES 的上游路径（取 ":" 前部分）。
  # ":-" 防止空数组在 set -u 下报错。
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

# 构造 rsync --exclude 参数。rsync 对字面源参数也应用 --exclude，
# 所以顶级和嵌套文件都能被排除，无需额外 glob 匹配。
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
  echo "==> Refreshing upstream files in ${dir}/ (local-only files preserved)"
  mkdir -p "${ROOT_DIR}/${dir}"
  # 逐个刷新上游拥有的条目；仅本地存在的条目不受影响。
  for entry in "${src}"/*; do
    name="$(basename "${entry}")"
    rm -rf "${ROOT_DIR:?}/${dir}/${name}"
    # -q：抑制被排除顶级条目的 "skipping excluded file" 警告。
    rsync -aq "${exclude_args[@]}" "${entry}" "${ROOT_DIR}/${dir}/"
    echo "  - ${dir}/${name}"
  done
done

# 格式见 .sync-config.sh；无 ":" 时原样镜像，有 ":" 则改名落地。
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
