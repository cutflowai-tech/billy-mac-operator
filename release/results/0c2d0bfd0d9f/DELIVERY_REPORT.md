# Billy 0.1.0: delivery report

**Status: NOT RELEASE_READY.** The strict evaluator (`evaluation.json` in this folder) reports 27 unmet gates. Almost all of them need things only the owner can provide. Everything below is bound to one candidate.

## Candidate

| | |
|---|---|
| Commit | `0c2d0bfd0d9fb3c007ffef070b3998b5da1ed2bd` (sealed in the app as `Contents/Resources/core/build-info.json`) |
| Artifact | `artifacts/release/0.1.0/Billy-0.1.0.zip`, sha256 `fd26fe4c5f28d67769888d39d5b9b4b673f7fdb15b8d2867193424da785cfba6` |
| Also shipped | `Billy-0.1.0.dmg`, `sbom.json`, `THIRD_PARTY_NOTICES.txt`, `build-manifest.json`, `SHA256SUMS` |
| Signing | ad-hoc (personal use; not Developer ID or notarized) |
| Requirement manifest | sha256 `eed9a89c…cdf467cda` (36 requirements, 104 mandatory scenarios), unchanged since it was frozen |
| Qualification run | Clean tree, no reused logs; results, matrix and evaluation are in this folder |

## Results by lane (104 mandatory scenarios)

| Lane | Pass | Fail | Not run |
|---|---|---|---|
| UNIT, CONTRACT, INTEGRATION, FAULT, SECURITY | 71 of 71 | 0 | 0 |
| PACKAGE | 6 | 1 (T-REL-09: A-02 is open) | 0 |
| NATIVE_LIVE | 8 | 3 (T-MAC-03, T-MAC-06\*, T-MAC-08) | 5 owner-gated, plus 2 with only contract evidence (T-MAC-09/10) |
| PROVIDER_LIVE | 0 | 0 | 3 (S1, S2) |
| REMOTE_LIVE | 0 | 0 | 5 (S4, and S1+S2) |

\* **T-MAC-06:** Billy correctly paused because the owner was using the Mac. The test then failed instead of waiting. The harness is fixed in commit 309d3b2 and passes 3/3 at that commit. It will count only in the next candidate's run.

## Measured evidence for this candidate

- **Active soak (T-REL-07):**
  - Ran 62.0 minutes against this exact zip (digest taken before unpacking).
  - 68 of 68 tasks completed, with 6 SIGKILL recoveries and 4 stop/resume cycles.
  - 28 of 28 external effects with no duplicates.
  - RSS went from 77 MB in the first quarter to 87 MB in the last.
- **Crash boundaries (T-REL-08):** 16 fault points, each injected repeatedly within this run, including the new Telegram admission window.
- **Native live (this run):**
  - Passed: Calculator with an OCR-verified display, the TextEdit Unicode round trip, same-title windows, moved/resized geometry, driver generation change, Billy.app accessibility (T-UX-05), the host probe and the bundled provider.
  - Native control runs only while the owner is idle (3 s before observing, 5 s before foreground input).
- **Independent review (T-REL-09):** a separate reviewer with a fresh, read-only context audited 4c77ee8, then cffef3a, 8bf512e, dddcee1 and 8948f2d.
  - It found 10 issues (A-01 to A-10); 7 are closed.
  - Its records are in `release/reviews.json`, and the review is bound to this candidate by commit.

## What blocks release, and who acts

| Blocker | Who | What unblocks it |
|---|---|---|
| A-02 (high, accepted residual): a granted app's save panel can save outside the granted folders in three narrow cases (see the register) | Owner decision, or more engineering | Either accept the residual risk explicitly and re-rate it, or have the panel-path verification built |
| T-AI-01/06/07 | Owner: S1 + S2 | Put the Anthropic key in Keychain `com.billy.provider.anthropic`, then run `BILLY_LIVE_BUDGET_USD=<n>` |
| T-REMOTE-01/02/03/04/06 | Owner: S4 (+ S1/S2) | Telegram bot token in Keychain, phone on cellular, then run `BILLY_REMOTE_LIVE=1` (supervised) |
| T-MAC-09/10/11, takeover gate | Owner: S6 | 5–10 minutes of supervised lock/unlock, permission revoke and mouse takeover |
| T-MAC-04 | Owner: S7 | A Chrome install the pinned driver accepts |
| T-UX-06, REQ-25 | Owner: S5 | Microphone and Speech permission |
| T-DUR-06, T-UX-01 | Owner: S8 | Install Billy.app and start its background service |
| T-MAC-03 (Finder), T-MAC-08 (save panel) | Engineering | Background AX cannot reach Finder's dynamic Edit menu, and pointer input to the save panel's file browser does not register. Diagnoses are in `docs/testing-and-release.md` ("Native control findings") |

The full instructions are in `docs/SETUP_PACKET.md`. After any of these, the candidate loop is: commit → independent review record → `tools/package.sh` → `tools/soak.ts` → `tools/qualify.ts --artifact …`.

## Runbooks and documents

`docs/operator-runbook.md`, `docs/developer-runbook.md`, `docs/remote-access.md`, `docs/architecture.md`, `docs/autonomy-and-policy.md`, `docs/contracts-and-state-machines.md`, `docs/testing-and-release.md`, `docs/threat-and-failure-register.md`, `docs/SETUP_PACKET.md`, `docs/adr/0001–0004`.
