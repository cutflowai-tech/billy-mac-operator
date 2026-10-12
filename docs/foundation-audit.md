# Foundation audit (summary)

Detailed evidence:
- `docs/foundation-audit-openclaw.md` (OpenClaw v2026.10.1 @ e178c39e)
- `docs/foundation-audit-cua.md` (cua-driver 0.26.1 @ cc54254)
- Pins: `upstream.lock.json`. Classifications: `reuse-gap-matrix.json`. Decisions: ADR-0001 through ADR-0004.

## Outcome
- **OpenClaw:** audited and used as a design reference, not as a runtime dependency (ADR-0001). Its Mac app cannot be built on this host. Its trust model conflicts with Billy's non-bypassable broker.
- **Cua driver:** reused directly as Billy's single desktop controller (ADR-0002), pinned by binary hash and team ID, and run as a private daemon in bounded mode.
- **Runtime surface:** a verified Node runtime plus one audited npm dependency (`@anthropic-ai/sdk` 0.128.0, 6 transitive packages, no install scripts).

## Classification rule
No capability is classified `VERIFIED_REUSE` from documentation alone (T-FOUND-05). "Pending live" entries stay unqualified until their live gates pass.
