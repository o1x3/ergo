#!/usr/bin/env sh
# ergo installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/o1x3/ergo/main/install.sh | sh
#
# Environment overrides:
#   ERGO_VERSION       pin a version (e.g. v0.2.0); defaults to latest
#   ERGO_INSTALL_DIR   install directory (default: /usr/local/bin or ~/.local/bin)
#   ERGO_DOWNLOAD_URL  override the full download URL (advanced)
set -eu

REPO="o1x3/ergo"
BIN="ergo"

red()   { printf '\033[31m%s\033[0m\n' "$1" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
info()  { printf '\033[36m▸\033[0m %s\n' "$1"; }

need() { command -v "$1" >/dev/null 2>&1 || { red "missing required command: $1"; exit 1; }; }
need uname
if command -v curl >/dev/null 2>&1; then DL="curl -fsSL"; DLO="curl -fsSL -o";
elif command -v wget >/dev/null 2>&1; then DL="wget -qO-"; DLO="wget -qO";
else red "need curl or wget"; exit 1; fi

# ---- detect platform ----
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) red "unsupported OS: $os (ergo supports macOS, Linux, and Windows)"; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *) red "unsupported architecture: $arch"; exit 1 ;;
esac
asset="${BIN}-${os}-${arch}"

# ---- resolve version ----
version="${ERGO_VERSION:-}"
if [ -z "$version" ]; then
  info "Resolving latest release…"
  version="$($DL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep -o '"tag_name": *"[^"]*"' | head -n1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
fi
if [ -z "$version" ]; then
  red "could not determine the latest version; set ERGO_VERSION (e.g. v0.2.0)"
  exit 1
fi

url="${ERGO_DOWNLOAD_URL:-https://github.com/${REPO}/releases/download/${version}/${asset}}"

# ---- choose install dir ----
dir="${ERGO_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then dir="/usr/local/bin";
  else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"

tmp="$(mktemp)"
info "Downloading ${asset} ${version}…"
if ! $DLO "$tmp" "$url"; then
  red "download failed: $url"
  rm -f "$tmp"
  exit 1
fi

# ---- verify checksum if available ----
sums_url="https://github.com/${REPO}/releases/download/${version}/SHA256SUMS.txt"
if sums="$($DL "$sums_url" 2>/dev/null)"; then
  expected="$(printf '%s\n' "$sums" | grep " ${asset}\$" | awk '{print $1}')"
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$tmp" | awk '{print $1}')";
    elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$tmp" | awk '{print $1}')";
    else actual=""; fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      red "checksum mismatch! expected $expected, got $actual"
      rm -f "$tmp"; exit 1
    fi
    [ -n "$actual" ] && info "Checksum verified."
  fi
fi

chmod +x "$tmp"
mv "$tmp" "$dir/$BIN"

green "✓ Installed ergo ${version} to ${dir}/${BIN}"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) printf '\n  %s is not on your PATH. Add it:\n    export PATH="%s:$PATH"\n\n' "$dir" "$dir" ;;
esac
"$dir/$BIN" --version >/dev/null 2>&1 && green "Run 'ergo auth login' to get started."
