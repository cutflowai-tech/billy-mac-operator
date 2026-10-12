# Billy

Billy is a personal operator for one owner's Mac. It runs owner goals as durable tasks. Every effect passes through a journal-before-dispatch action broker that enforces grants, budget, stop and reconciliation. It controls native apps through a pinned, bounded computer-use driver, takes tasks from a paired phone, and ships as a native macOS app.

**Status: not release-ready.** The release gate (`release/evaluator/evaluate.ts`) has not passed. Mandatory live scenarios need owner-provided prerequisites (AI provider key and budget, Telegram phone pairing, microphone, supervised sessions, installed service). Two native scenarios (Finder copy, save-panel folder navigation) fail, with documented diagnoses. Several high-severity fixes still await an approving independent review. See:

- `docs/testing-and-release.md`: lanes, live status, native-control findings
- `docs/threat-and-failure-register.md`: every finding, its resolution and its evidence
- `docs/SETUP_PACKET.md`: the prerequisites only the owner can provide
- `release/requirements.manifest.json`: the frozen acceptance baseline (36 requirements, 104 mandatory scenarios)

## Development preview

The GitHub development preview includes an installable, ad-hoc-signed app for personal use on Apple Silicon Macs. It is published as a **prerelease**, with the release gate still enforced. Full native GUI qualification, real-provider tasks, phone pairing and a 60-minute active soak remain required before a production readiness claim.

After installing Billy in Applications, open onboarding and start the background service. In Settings, store your Anthropic key, activate the provider and check the available models, then configure your own budget and grant. These settings are required before tasks can run. CuaDriver 0.26.1 must be installed separately with Accessibility and Screen Recording permission; see `docs/SETUP_PACKET.md`. Runtime data is stored on the internal disk in your account's Application Support folder.

The review fixes provider activation, desktop token redaction and truncated planner observations, resource queue stalls, and cancellation of pending model calls. Task completion checks now enforce current file authority. Desktop session monitoring uses a resident native helper, takeover history is bounded, web responses stop downloading at one megabyte, and installed logs use the running user's home.

GitHub Actions runs deterministic core, security, fault, evaluator and native contract tests on macOS. Live tests are separate from CI; passing CI does not mean the frozen release gate has passed.

## Layout

| Path | What |
|---|---|
| `core/` | TypeScript core (Node 26, type-stripped, zero runtime dependencies except the Anthropic SDK): broker, policy, budget, scheduler, desktop tools, daemon, CLI |
| `native/` | Swift app (SwiftUI), client kit, OCR helper, self-hosted test runner |
| `release/` | Frozen manifest, strict release evaluator, review binding, findings and reviews |
| `tools/` | Packaging, qualification, soak, independent-review reproduction and attestation |
| `tests/` | Bootstrap and build-continuation tests; native fixture apps |
| `docs/` | Architecture, policy, runbooks, ADRs, setup packet, threat register |

## Running the tests

```bash
cd core && node --test --test-concurrency=1 test/unit/*.test.ts test/integration/*.test.ts test/security/*.test.ts
cd core && node --test --test-concurrency=1 test/fault/*.test.ts
node --test release/evaluator/*.test.ts
```

The live suites (`core/test/live/`) need a real Mac session and owner prerequisites; see `docs/testing-and-release.md`.
