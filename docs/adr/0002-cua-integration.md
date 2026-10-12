# ADR-0002: Cua driver integration boundary

Status: Accepted (2026-10-11) · REQ-10, REQ-11, REQ-12, REQ-15, REQ-33 · Evidence: docs/foundation-audit-cua.md

## Facts (0.26.1, commit cc54254464c0c9aebfd6547fe7e4a0ceaf0456d7, binary sha256 51b7515e…)
- Daemon socket auth = same macOS user only (no token). Any same-user process can call every tool.
- `call` may exit 0 on tool failure/refusal; JSON must be parsed.
- Telemetry on by default (PostHog EU); per-process off via `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`.
- Bounded mode + capability manifest (YAML v3) can only narrow scope; fixed at daemon start.
- Element tokens are snapshot-bound; stale tokens are refused (good fit for observation-bound actions).
- TCC attribution follows LaunchServices launch of CuaDriver.app; a directly spawned child may inherit Billy's responsibility chain (unverified).

## Decision
1. Billy pins the **installed 0.26.1** by binary sha256 + team ID; startup refuses a mismatched binary (visible failure). Upgrading to 0.34.x is a later controlled update with re-audit (not during qualification).
2. Billy runs a **private daemon** on a Billy-owned socket path, launched via LaunchServices, in **bounded mode** with a Billy-generated capability manifest derived from the owner's grants, telemetry and update checks disabled.
3. The broker is the only Billy component that talks to the socket. Untrusted/generated code runs under a Seatbelt profile that denies the Cua socket directories, Billy's data dir, and Keychain (T-SEC-03/07/11).
4. All results are parsed from JSON; exit codes are never trusted alone.
5. Residual risk (stated in threat register): non-Billy same-user processes can reach any Cua socket; Billy cannot fix that without OS-level identity checks.
