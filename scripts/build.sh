#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
DIST_DIR="$ROOT_DIR/dist"

# Версию берём из Chrome-манифеста (простым парсингом) или переопределяем переменной среды VERSION
VERSION="${VERSION:-$(sed -n 's/^  \"version\": \"\(.*\)\",/\1/p' "$EXT_DIR/manifest.json" | head -n1)}"
if [ -z "$VERSION" ]; then VERSION="0.2.0"; fi

mkdir -p "$DIST_DIR"

function build_chrome() {
  local out="$DIST_DIR/app-url-crawler-chrome-$VERSION.zip"
  (cd "$EXT_DIR" && zip -q -r "$out" .)
  echo "Chrome ZIP: $out"
}

function build_firefox() {
  local tmp
  tmp=$(mktemp -d)
  rsync -a --exclude manifest.json "$EXT_DIR/" "$tmp/extension/"
  cp "$EXT_DIR/manifest.firefox.json" "$tmp/extension/manifest.json"
  local out="$DIST_DIR/app-url-crawler-firefox-$VERSION.zip"
  (cd "$tmp/extension" && zip -q -r "$out" .)
  rm -rf "$tmp"
  echo "Firefox ZIP: $out"
}

case "${1:-all}" in
  chrome) build_chrome ;;
  firefox) build_firefox ;;
  all) build_chrome; build_firefox ;;
  *) echo "Usage: $0 [chrome|firefox|all]"; exit 1 ;;
esac
