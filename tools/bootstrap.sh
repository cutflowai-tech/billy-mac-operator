#!/bin/bash
# Non-destructive Billy workspace bootstrap (T-BOOT-01).
#   tools/bootstrap.sh <workspace>
# - Never resets, checks out, stashes, cleans or overwrites anything.
# - Initialises git only when the directory is not already a repository.
# - Creates missing standard directories; existing files are left untouched.
# - Records the chosen workspace, branch, HEAD and dirty state.
set -euo pipefail
WS="${1:?usage: tools/bootstrap.sh <workspace>}"
mkdir -p "$WS"
cd "$WS"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git init -q -b main; fi
for d in docs/adr contracts tests execution release upstream tools artifacts; do [ -e "$d" ] || mkdir -p "$d"; done
BRANCH="$(git symbolic-ref --short -q HEAD || echo detached)"
HEAD_SHA="$(git rev-parse -q --verify HEAD || echo none)"
DIRTY="$(git status --porcelain | wc -l | tr -d ' ')"
REC="execution/bootstrap-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
[ -e "$REC" ] && { echo "refusing to overwrite $REC" >&2; exit 3; }
printf '{ "workspace": "%s", "branch": "%s", "head": "%s", "dirty_entries_preserved": %s, "at": "%s" }\n' \
  "$(pwd -P)" "$BRANCH" "$HEAD_SHA" "$DIRTY" "$(date -u +%FT%TZ)" > "$REC"
echo "workspace $(pwd -P) on $BRANCH ($HEAD_SHA), $DIRTY pre-existing change(s) preserved -> $REC"
