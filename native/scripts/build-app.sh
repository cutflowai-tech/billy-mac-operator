#!/bin/bash
# Assembles artifacts/build/Billy.app from the Swift package (Command Line Tools only).
#
#   native/scripts/build-app.sh [--core <core dir>] [--node <node binary>] [--version X.Y.Z] [--out <dir>]
#
#   --core   copy a core checkout (with node_modules) into Contents/Resources/core
#   --node   copy this Node.js binary into Contents/Resources/node/bin/node
# Without --core/--node the app runs as a client only and shows "service not installed".
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # native/
ROOT="$(cd "$HERE/.." && pwd)"                    # repo root
OUT="$ROOT/artifacts/build"
VERSION="0.1.0"
CORE=""
NODE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --core) CORE="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
BUILD="$(git -C "$ROOT" rev-list --count HEAD 2>/dev/null || echo 1)"

echo "==> swift build -c release"
(cd "$HERE" && swift build -c release --product Billy)
(cd "$HERE" && swift build -c release --product billy-ocr)
(cd "$HERE" && swift build -c release --product billy-session)
BIN="$(cd "$HERE" && swift build -c release --show-bin-path)/Billy"

APP="$OUT/Billy.app"
C="$APP/Contents"
echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$C/MacOS" "$C/Resources/billyd" "$C/Library/LaunchAgents"
cp "$BIN" "$C/MacOS/Billy"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" "$HERE/Resources/Info.plist" > "$C/Info.plist"
printf 'APPL????' > "$C/PkgInfo"
cp "$HERE/Resources/com.billy.core.plist" "$C/Library/LaunchAgents/com.billy.core.plist"
install -m 0755 "$HERE/Resources/billyd" "$C/Resources/billyd/billyd"
install -m 0755 "$HERE/Resources/billyctl" "$C/Resources/billyd/billyctl"
mkdir -p "$C/Resources/bin" && install -m 0755 "$(cd "$HERE" && swift build -c release --show-bin-path)/billy-ocr" "$C/Resources/bin/billy-ocr"
install -m 0755 "$(cd "$HERE" && swift build -c release --show-bin-path)/billy-session" "$C/Resources/bin/billy-session"
plutil -lint "$C/Info.plist" "$C/Library/LaunchAgents/com.billy.core.plist" >/dev/null

if [ -n "$NODE" ]; then
  echo "==> embedding node runtime: $NODE"
  mkdir -p "$C/Resources/node/bin"
  cp "$(realpath "$NODE")" "$C/Resources/node/bin/node"
  chmod 0755 "$C/Resources/node/bin/node"
fi
if [ -n "$CORE" ]; then
  echo "==> embedding core: $CORE"
  mkdir -p "$C/Resources/core"
  rsync -a --exclude test --exclude '.git' "$CORE/" "$C/Resources/core/"
fi

echo "==> icon"
ICONTMP="$(mktemp -d)"
trap 'rm -rf "$ICONTMP"' EXIT
swift "$HERE/scripts/make-icon.swift" "$ICONTMP/icon-1024.png" >/dev/null
SET="$ICONTMP/AppIcon.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICONTMP/icon-1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$ICONTMP/icon-1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$C/Resources/AppIcon.icns"

echo "==> ad-hoc signing (personal-use build; not Developer ID / notarized)"
# The embedded Node keeps its official Node.js Foundation signature (provenance);
# files under Resources are sealed by the bundle signature, not re-signed.
if [ -f "$C/Resources/node/bin/node" ]; then
  codesign --verify --strict "$C/Resources/node/bin/node"
fi
codesign --force --options runtime --entitlements "$HERE/Resources/Billy.entitlements" -s - "$APP"
codesign --verify --deep --strict "$APP"
codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -p - 2>/dev/null || true

echo "==> done"
echo "app:      $APP"
echo "embedded: core=$([ -n "$CORE" ] && echo yes || echo no) node=$([ -n "$NODE" ] && echo yes || echo no)"
shasum -a 256 "$C/MacOS/Billy"
