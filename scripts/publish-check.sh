#!/usr/bin/env bash
# Builds the plugin check (pipeline/check-action/) from the current checkout and makes a local tag
# for it: check-v<major>, pointing at an orphan commit that holds only the built files (action.yml,
# package.json, README.md, LICENSE, check.mjs and check-data.json.gz), so that
#   uses: iliasbeshimov/zoteroplugins.org@check-v1
#   npx github:iliasbeshimov/zoteroplugins.org#check-v1 file.xpi
# get plain JavaScript and the day's tables.
#
# The hosts table, library index and hand reviews change nightly and a tag is frozen, so the tag is
# rebuilt and moved forward (-f) every time this runs; run it after each census/profile build.
# It never pushes. To publish: git push --force origin check-v<major>
#
#   scripts/publish-check.sh --dry-run   build, list what the commit would hold, change no ref
#   scripts/publish-check.sh             also write the orphan commit and move the local tag
#
# The major version comes from pipeline/check-action/package.json (a breaking change to the
# action's inputs or report format starts check-v2); CHECK_MAJOR overrides it.
set -euo pipefail

dry=0
case "${1:-}" in
  --dry-run) dry=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel)"
cd "$root"
major="${CHECK_MAJOR:-$(node -p "require('./pipeline/check-action/package.json').version.split('.')[0]")}"
tag="check-v${major}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pkg="$tmp/pkg"

node pipeline/check-action/build.mjs "$pkg"

echo
echo "The commit for ${tag} would hold:"
(cd "$pkg" && ls -l | awk 'NR>1 {printf "  %9d  %s\n", $5, $NF}')
du -sk "$pkg" | awk '{printf "  total %d KB\n", $1}'

if [ "$dry" = 1 ]; then
  echo "Dry run: no commit or tag was made."
  exit 0
fi

# A temporary index and work tree keep the real ones untouched; commit-tree with no parent makes
# the commit an orphan.
export GIT_INDEX_FILE="$tmp/index"
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Ilias Beshimov}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-2678455+iliasbeshimov@users.noreply.github.com}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"
git --work-tree="$pkg" add -A .
tree="$(git write-tree)"
built="$(date -u +%Y-%m-%d)"
commit="$(git commit-tree "$tree" -m "Plugin check ${tag}: tables of ${built}")"
unset GIT_INDEX_FILE
git tag -f "$tag" "$commit"
echo "Local tag ${tag} -> ${commit} (orphan). Not pushed."
