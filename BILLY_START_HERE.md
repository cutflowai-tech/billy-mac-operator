# Billy — Start Here

## What this package is

This is the English engineering handoff for building Billy, the owner's autonomous macOS AI Operator. It is not the Billy application and does not claim any Billy implementation or live test has been completed.

The master handoff is self-contained. It contains the requirements, full execution plan, detailed acceptance scenarios, and sources. The JSON files are supporting machine-readable specifications; the validation script checks those handoff files only.

## Submit one handoff

Attach `BILLY_MASTER_HANDOFF.md` to one lead coding-agent conversation in an environment that can read/write the selected workspace, run actual commands, manage persistent work, delegate internally, and reach the authorized Mac for native tests. The complete bundle can be provided instead when that runtime can read archives. Do not send separate phase prompts or create owner-managed builder chats.

Use this launch prompt:

```text
You are the lead engineering and delivery agent for Billy.

Read the attached BILLY_MASTER_HANDOFF.md completely. Treat it as the
project's engineering and acceptance baseline, subject to actual owner
authorization and your host/OS/provider restrictions. The file is
self-contained; its optional JSON companions mirror the requirements.

Your task is to build and deliver the complete scoped product, not to
return another plan, stop after the audit, or produce only an MVP.

Use one primary conversation with me. Delegate internally as useful.
Own architecture, implementation, integration, testing, recovery,
independent review, packaging, and the final evidence report.

Start by discovering the actual environment and proving the build
runtime's continuation mechanism. Audit and pin the proposed upstream
foundation before relying on it. Reuse verified existing capabilities;
add only the demonstrated gaps. Keep the development orchestrator
separate from Billy's unfinished product runtime.

Create the persistent task ledger and freeze all 36 requirements and
104 mandatory acceptance scenarios. Then execute the full dependency
plan. Move automatically between phases. Do not ask me to approve
routine implementation decisions, run tests, fix errors, or continue.

Discover missing prerequisites before asking. Consolidate genuine
human-only setup, credentials, scope and budget needs into one precise
packet, and continue independent work while those items are blocked.
Never invent permissions, credentials, spending authority, model IDs,
background execution, or successful tests.

Preserve all required product capabilities. Do not reduce scope,
weaken acceptance criteria, remove failing tests, or count mocked,
skipped or unrun live gates as passed. Reconcile uncertain external
effects before retrying. Honor explicit stop/revocation immediately.

Deliver the actual installable personal-use Mac artifact, integrated
source, tested runbooks, and candidate-bound acceptance evidence.
Declare RELEASE_READY only when every mandatory gate has truly passed.

Begin now with environment discovery and the first real proofs, then
continue through implementation and qualification without waiting for
routine approval.
```

## Files

| File | Purpose |
|---|---|
| `BILLY_MASTER_HANDOFF.md` | Authoritative self-contained English handoff. |
| `BILLY_REQUIREMENTS_AND_TESTS.json` | Machine-readable mirror: 36 requirements and 104 scenarios, all explicitly not yet executed. |
| `HANDOFF_REGISTRY.schema.json` | Structural schema for that requirement/test registry. |
| `BILLY_RELEASE_REPORT.schema.json` | Proposed structure for future actual release evidence; semantic gate checks are still required. |
| `validate_handoff.py` | Dependency-free consistency check for this handoff package only. |
| `HANDOFF_VALIDATION_REPORT.json` | Results of document/registry validation performed when packaging. Not software qualification. |
| `SHA256SUMS.txt` | Integrity hashes for the packaged files. Hashes are not a digital signature or proof of software correctness. |

## Check the handoff package

Run `python3 validate_handoff.py` from this directory. This verifies document identifiers, coverage, registry status, required files and source-reference integrity. It does **not** invoke AI providers, control a Mac, run Billy tests, or evaluate a release candidate.

## The important boundary

The objective is one owner handoff and one owner-facing conversation, with automatic internal continuation. It is not an unlimited model invocation or a guarantee that a chat-only environment can operate after its runtime stops. The lead must verify actual continuation support before claiming unattended execution.

No workspace, account, remote service or budget is assumed to have been authorized merely by this package. The executing environment resolves those prerequisites under the handoff's discovery and consolidated-onboarding rules.
