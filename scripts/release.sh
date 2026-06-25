#!/usr/bin/env bash
# Cut a release: bump version in package.json + src/version.ts, commit, tag, push.
# CI (release.yml) builds the binaries and publishes the GitHub release.
#
# Usage: scripts/release.sh <new-version>   e.g. scripts/release.sh 0.2.0
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "usage: scripts/release.sh <version>  (e.g. 0.2.0)" >&2
  exit 1
fi
if ! echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'; then
  echo "error: '$VERSION' is not a valid semver" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is dirty; commit or stash first" >&2
  exit 1
fi

echo "▸ Bumping to $VERSION"
# package.json
bun -e "const p=await Bun.file('package.json').json();p.version='$VERSION';await Bun.write('package.json',JSON.stringify(p,null,2)+'\n')"
# src/version.ts
printf "// Single source of truth for the ergo version. Kept in sync with package.json\n// by scripts/release.sh at release time.\nexport const VERSION = '%s';\n" "$VERSION" > src/version.ts

bun run typecheck
bun test

git add package.json src/version.ts
git commit -m "release: v$VERSION"
git tag -s "v$VERSION" -m "ergo v$VERSION"

echo "✓ Committed and tagged v$VERSION"
echo "  Push with: git push origin main --follow-tags"
