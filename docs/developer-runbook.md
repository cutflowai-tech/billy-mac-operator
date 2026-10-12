# Billy — Developer Runbook

## Prerequisites (verified on the qualified host)
| Item | Value |
|---|---|
| macOS | 26.5.2, arm64 |
| Toolchain | Command Line Tools with Swift 6.2.3. **Xcode is not required.** |
| Node | 26.x for development (`node` on PATH) |
| Packaging runtime | official Node v26.8.2 tarball, checksum-verified (vendor step below) |

### Vendor step (once)
```bash
mkdir -p artifacts/vendor/node && cd artifacts/vendor/node
curl -fsSLO https://nodejs.org/dist/v26.8.2/SHASUMS256.txt
curl -fsSLO https://nodejs.org/dist/v26.8.2/node-v26.8.2-darwin-arm64.tar.gz
grep " node-v26.8.2-darwin-arm64.tar.gz$" SHASUMS256.txt > expected.txt && shasum -a 256 -c expected.txt
```
`tools/package.sh` re-verifies the digest. It also requires the Node.js Foundation signer (team HX7739G8FX).

## Core
```bash
cd core
npm ci --ignore-scripts        # 1 runtime dependency (@anthropic-ai/sdk 0.128.0) + dev typechecker
npx tsc -p tsconfig.json       # typecheck (Node runs .ts directly via type stripping)
node --test --test-concurrency=1 'test/unit/*.test.ts' 'test/integration/*.test.ts' 'test/security/*.test.ts'
BILLY_FAULT_INJECTIONS=10 node --test --test-concurrency=1 'test/fault/*.test.ts'
# Build the native session helper before using desktop tools in development:
(cd ../native && swift build --product billy-session)
node src/daemon/main.ts --data-dir /tmp/billy-dev --allow-unsafe-location   # dev daemon
```

## Native app
```bash
cd native
swift build && .build/debug/BillyTests       # self-hosted test runner (no XCTest under CLT)
scripts/build-app.sh                          # client-only app in artifacts/build
```

## Release
```bash
git status --porcelain                 # must be empty: the packager refuses a dirty tree
tools/package.sh --version 0.1.0       # builds from `git archive HEAD` into artifacts/release/0.1.0
node tools/qualify.ts --artifact artifacts/release/0.1.0/Billy-0.1.0.zip
```
`qualify.ts` runs every suite and maps tests to scenario IDs with their real lanes. It writes `release/results/<commit>/` and runs the strict evaluator (`release/evaluator/evaluate.ts`). It exits 0 only on RELEASE_READY.

## Development continuation
```bash
tools/billy-dev status        # authoritative ledger state (execution/ledger.json)
tools/billy-dev brief         # recovery brief generated from the ledger
python3 -I tests/boot/test_build_continuation.py
```

## Upstream updates and rollback
1. Never update during a qualification run.
2. **CuaDriver:** install the new version, re-audit it (`docs/foundation-audit-cua.md`), then update `cua.binary_sha256` and `cua.team_id` in config and `upstream.lock.json`. Re-run the desktop and native suites. Rollback: reinstall 0.26.1 (hash `51b7515e…`).
3. **@anthropic-ai/sdk:** pick a version at least two weeks old, then `npm install --ignore-scripts --save-exact`. Check for new install scripts and dependencies, update `upstream.lock.json`, and re-run the provider suites.
4. **Schema changes:** add a new `Migration` (never edit an applied one). Take a backup first (`billyctl backup-create`); rollback is a restore of that backup (T-REL-05).
5. **App updates:** `admitUpdate()` (`core/src/update/verify.ts`) refuses artifacts whose hash or signer does not match. The existing install is untouched on refusal.
