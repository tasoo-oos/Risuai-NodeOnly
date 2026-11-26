#!/usr/bin/env bash
# Fork delta guard.
#
# Fails when the downstream soft-fork delta against an upstream base touches a
# path that is not declared in scripts/fork-allowlist.txt. Run it before every
# upstream sync so fork-only code cannot sprawl across the tree unnoticed.
#
# Usage: scripts/fork-delta.sh [base-ref]   (default: upstream/develop)

set -euo pipefail

base="${1:-upstream/develop}"
repo_root="$(git rev-parse --show-toplevel)"
allowlist="$repo_root/scripts/fork-allowlist.txt"

if [[ ! -f "$allowlist" ]]; then
  echo "fork-delta: missing $allowlist" >&2
  exit 2
fi

if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  echo "fork-delta: base ref '$base' does not exist" >&2
  exit 2
fi

echo "Fork delta vs $base"
echo "-------------------"
git diff --stat "$base...HEAD"
echo

fail=0
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  matched=0
  while IFS= read -r pattern; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    # shellcheck disable=SC2053  # unquoted pattern is intentional (glob match)
    if [[ "$file" == $pattern ]]; then
      matched=1
      break
    fi
  done < "$allowlist"
  if [[ "$matched" -eq 0 ]]; then
    echo "UNLISTED  $file" >&2
    fail=1
  fi
done < <(git diff --name-only "$base...HEAD")

echo
if [[ "$fail" -ne 0 ]]; then
  echo "Fork delta touches paths not on the allowlist." >&2
  echo "Either shrink the delta/upstream the change, or add the path to" >&2
  echo "scripts/fork-allowlist.txt deliberately." >&2
  exit 1
fi

echo "OK: every changed path is on the fork allowlist."
