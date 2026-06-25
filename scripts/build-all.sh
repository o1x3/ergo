#!/usr/bin/env bash
# Cross-compile ergo into standalone single-file binaries.
#
# Usage:
#   scripts/build-all.sh                 # build every target
#   scripts/build-all.sh darwin          # only darwin-* targets
#   scripts/build-all.sh linux windows   # linux-* and windows-* targets
#
# macOS binaries are ad-hoc codesigned when `codesign` is available (required to
# run on Apple Silicon). Build darwin targets on a macOS runner to sign them.
set -euo pipefail

cd "$(dirname "$0")/.."

ENTRY="src/cli/index.ts"
OUT="dist/release"
mkdir -p "$OUT"

# target triple -> output filename
all_targets=(
  "bun-darwin-arm64:ergo-darwin-arm64"
  "bun-darwin-x64:ergo-darwin-x64"
  "bun-linux-x64:ergo-linux-x64"
  "bun-linux-arm64:ergo-linux-arm64"
  "bun-windows-x64:ergo-windows-x64.exe"
)

filters=("$@")
matches() {
  [ ${#filters[@]} -eq 0 ] && return 0
  for f in "${filters[@]}"; do
    case "$1" in *"$f"*) return 0 ;; esac
  done
  return 1
}

built=0
for entry in "${all_targets[@]}"; do
  target="${entry%%:*}"
  name="${entry##*:}"
  matches "$name" || continue
  echo "▸ Building $name ($target)"
  bun build "$ENTRY" \
    --compile \
    --minify \
    --sourcemap=none \
    --target="$target" \
    --outfile "$OUT/$name"
  case "$name" in
    *darwin*)
      if command -v codesign >/dev/null 2>&1; then
        echo "  ↳ ad-hoc codesigning $name"
        codesign --force --sign - "$OUT/$name"
      else
        echo "  ! codesign unavailable — $name will not run on Apple Silicon until signed"
      fi
      ;;
  esac
  built=$((built + 1))
done

echo "✓ Built $built binar$([ "$built" -eq 1 ] && echo y || echo ies) in $OUT"
ls -lh "$OUT"
