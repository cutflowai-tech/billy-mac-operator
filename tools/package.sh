#!/bin/bash
# Build the personal-use Billy release from the COMMITTED tree (never from a dirty
# working copy), so the artifact digest is bound to an exact commit.
#   tools/package.sh [--version X.Y.Z] [--allow-dirty]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="0.1.0"; ALLOW_DIRTY=0
while [ $# -gt 0 ]; do case "$1" in --version) VERSION="$2"; shift 2;; --allow-dirty) ALLOW_DIRTY=1; shift;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
cd "$ROOT"
if [ -n "$(git status --porcelain)" ] && [ "$ALLOW_DIRTY" != 1 ]; then echo "refusing: working tree is dirty (artifact must match a commit)" >&2; exit 3; fi
COMMIT="$(git rev-parse HEAD)"
NODE_VER="v26.8.2"; NODE_TGZ="$ROOT/artifacts/vendor/node/node-$NODE_VER-darwin-arm64.tar.gz"; SUMS="$ROOT/artifacts/vendor/node/SHASUMS256.txt"
[ -f "$NODE_TGZ" ] && [ -f "$SUMS" ] || { echo "missing verified Node runtime: run the vendor step in docs/developer-runbook.md" >&2; exit 4; }
WANT="$(grep " node-$NODE_VER-darwin-arm64.tar.gz$" "$SUMS" | cut -d' ' -f1)"
GOT="$(shasum -a 256 "$NODE_TGZ" | cut -d' ' -f1)"
[ "$WANT" = "$GOT" ] || { echo "Node tarball digest mismatch" >&2; exit 5; }
WORK="$(mktemp -d /tmp/claude-501/billy-pkg.XXXXXX 2>/dev/null || mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "==> staging committed tree $COMMIT"
mkdir -p "$WORK/src" && git archive "$COMMIT" | tar -x -C "$WORK/src"
echo "==> runtime"
tar -xzf "$NODE_TGZ" -C "$WORK"
NODE="$WORK/node-$NODE_VER-darwin-arm64/bin/node"
codesign --verify --strict "$NODE"
TEAM="$(codesign -dv "$NODE" 2>&1 | sed -n 's/^TeamIdentifier=//p')"; [ "$TEAM" = "HX7739G8FX" ] || { echo "unexpected Node signer $TEAM" >&2; exit 6; }
echo "==> core production dependencies (no install scripts)"
(cd "$WORK/src/core" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
rm -rf "$WORK/src/core/test"
# Sealed inside the signed app: lets qualification prove which commit the artifact was built from.
printf '{ "version": "%s", "commit": "%s" }\n' "$VERSION" "$COMMIT" > "$WORK/src/core/build-info.json"
echo "==> notices + SBOM"
node "$ROOT/tools/notices.ts" "$WORK/src/core" "$WORK/node-$NODE_VER-darwin-arm64" "$WORK/src/core/THIRD_PARTY_NOTICES.txt" "$WORK/sbom.json"
echo "==> app"
OUT="$ROOT/artifacts/release/$VERSION"; rm -rf "$OUT"; mkdir -p "$OUT"
"$WORK/src/native/scripts/build-app.sh" --core "$WORK/src/core" --node "$NODE" --version "$VERSION" --out "$OUT" | tail -3
APP="$OUT/Billy.app"
echo "==> archives"
(cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent Billy.app "Billy-$VERSION.zip")
hdiutil create -quiet -fs HFS+ -volname "Billy $VERSION" -srcfolder "$APP" -ov -format UDZO "$OUT/Billy-$VERSION.dmg"
cp "$WORK/sbom.json" "$OUT/sbom.json"
cp "$WORK/src/core/THIRD_PARTY_NOTICES.txt" "$OUT/THIRD_PARTY_NOTICES.txt"
EXE_SHA="$(shasum -a 256 "$APP/Contents/MacOS/Billy" | cut -d' ' -f1)"
TREE_SHA="$(cd "$OUT" && find Billy.app -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
cat > "$OUT/build-manifest.json" <<JSON
{ "version": "$VERSION", "commit": "$COMMIT", "built_at": "$(date -u +%FT%TZ)",
  "node": { "version": "$NODE_VER", "tarball_sha256": "$GOT", "signer_team": "$TEAM" },
  "swift": "$(swift --version 2>&1 | head -1 | sed 's/"/\\"/g')", "macos": "$(sw_vers -productVersion)",
  "signing": "ad-hoc (personal use; not Developer ID / notarized)",
  "app_executable_sha256": "$EXE_SHA", "app_tree_sha256": "$TREE_SHA" }
JSON
(cd "$OUT" && shasum -a 256 "Billy-$VERSION.zip" "Billy-$VERSION.dmg" sbom.json THIRD_PARTY_NOTICES.txt build-manifest.json > SHA256SUMS)
cat "$OUT/SHA256SUMS"
echo "release: $OUT"
