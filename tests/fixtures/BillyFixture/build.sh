#!/bin/bash
# Builds the test-only fixture apps (ad-hoc signed, registered with LaunchServices so the pinned
# driver can launch them by bundle id). Never packaged. Two apps from one binary, distinct identities:
#   artifacts/fixtures/BillyFixture.app   com.billy.fixture
#   artifacts/fixtures/BillyFixtureB.app  com.billy.fixture.b
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"
(cd "$HERE" && swift build -c release)
make_app() {
  local NAME="$1" ID="$2"
  local APP="$ROOT/artifacts/fixtures/$NAME.app"; rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
  cp "$(cd "$HERE" && swift build -c release --show-bin-path)/BillyFixture" "$APP/Contents/MacOS/$NAME"
  cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$ID</string>
<key>CFBundleName</key><string>$NAME</string>
<key>CFBundleExecutable</key><string>$NAME</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PL
  codesign --force --sign - "$APP"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
  echo "$APP"
}
make_app BillyFixture com.billy.fixture
make_app BillyFixtureB com.billy.fixture.b
