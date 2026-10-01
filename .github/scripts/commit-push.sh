#!/usr/bin/env bash
# Commit the given paths (if they changed) and push to main, rebasing on whatever landed meanwhile.
# Usage: commit-push.sh "<message>" <path>...   Prints changed=true|false to $GITHUB_OUTPUT.
set -euo pipefail
msg="$1"; shift
git add -A -- "$@"
if git diff --cached --quiet; then
  echo "changed=false" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git commit -q -m "$msg"
for i in 1 2 3 4 5; do
  if git pull -q --rebase origin main && git push -q origin HEAD:main; then
    echo "changed=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    exit 0
  fi
  sleep $((i * 5))
done
echo "::error::push failed after 5 tries"
exit 1
