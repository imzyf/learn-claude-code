#!/usr/bin/env bash
#
# Sync the Python reference sources from upstream shareAI-lab/learn-claude-code
# into this repo, which is the TypeScript port of that project.
#
# For each dir in SYNC_DIRS (see .sync-config.sh) the upstream-owned files
# (code.py, README*.md, images/) are refreshed in place. The TS files you
# write alongside them (code.ts, ...) are left untouched, so you can keep
# the Python reference next to your port and see upstream changes with
# `git diff` after each sync, then port them by hand.
#
# The upstream clone is sparse (only SYNC_DIRS + SYNC_FILES) and cached
# under CACHE_DIR for CACHE_TTL_SECONDS (default 1 day), so re-running the
# same day reuses it. Delete CACHE_DIR or set LCC_SYNC_CACHE_TTL=0 to force
# a fresh clone.
#
# Usage: bin/sync-upstream.sh
#
# Env overrides:
#   LCC_SYNC_CACHE_DIR   where to keep the cached upstream clone
#   LCC_SYNC_CACHE_TTL   cache lifetime in seconds (0 = always re-clone)

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
  # Every path we want checked out: synced dirs, same-name files, and the
  # upstream side of each rename. Guarded so empty arrays are safe under -u.
  sparse_paths=()
  for p in "${SYNC_DIRS[@]:-}" "${SYNC_FILES[@]:-}"; do
    [[ -n "${p}" ]] && sparse_paths+=( "/${p}" )
  done
  for pair in "${SYNC_RENAMES[@]:-}"; do
    [[ -n "${pair}" ]] && sparse_paths+=( "/${pair%%:*}" )
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

for dir in "${SYNC_DIRS[@]}"; do
  src="${clone_dir}/${dir}"
  if [[ ! -d "${src}" ]]; then
    echo "!! Skipping ${dir} (not found upstream)"
    continue
  fi
  echo "==> Refreshing upstream files in ${dir}/ (TS files preserved)"
  mkdir -p "${ROOT_DIR}/${dir}"
  # Copy each upstream-owned entry, replacing only that entry. Entries that
  # exist only locally (your code.ts, etc.) are never removed.
  for entry in "${src}"/*; do
    name="$(basename "${entry}")"
    rm -rf "${ROOT_DIR:?}/${dir}/${name}"
    cp -R "${entry}" "${ROOT_DIR}/${dir}/${name}"
    echo "  - ${dir}/${name}"
  done
done

for file in "${SYNC_FILES[@]:-}"; do
  [[ -n "${file}" ]] || continue
  src="${clone_dir}/${file}"
  if [[ ! -f "${src}" ]]; then
    echo "!! Skipping ${file} (not found upstream)"
    continue
  fi
  echo "==> Mirroring ${file}"
  cp "${src}" "${ROOT_DIR}/${file}"
done

for pair in "${SYNC_RENAMES[@]:-}"; do
  [[ -n "${pair}" ]] || continue
  src_rel="${pair%%:*}"
  dest_rel="${pair#*:}"
  src="${clone_dir}/${src_rel}"
  if [[ ! -f "${src}" ]]; then
    echo "!! Skipping ${src_rel} (not found upstream)"
    continue
  fi
  echo "==> Mirroring ${src_rel} -> ${dest_rel}"
  mkdir -p "$(dirname "${ROOT_DIR}/${dest_rel}")"
  cp "${src}" "${ROOT_DIR}/${dest_rel}"
done

if (( ${#PRUNE_GLOBS[@]} )); then
  echo "==> Pruning localized files (${PRUNE_GLOBS[*]})"
  for dir in "${SYNC_DIRS[@]}"; do
    target="${ROOT_DIR}/${dir}"
    [[ -d "${target}" ]] || continue
    for glob in "${PRUNE_GLOBS[@]}"; do
      while IFS= read -r -d '' f; do
        rm -f "${f}"
        echo "  - ${f#"${ROOT_DIR}"/}"
      done < <(find "${target}" -type f -name "${glob}" -print0)
    done
  done
fi

echo "==> Done. Review upstream changes with: git diff"
