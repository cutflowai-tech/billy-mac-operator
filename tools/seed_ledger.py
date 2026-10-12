#!/usr/bin/env python3
"""Seed execution/ledger.json with the Billy delivery task graph (run once)."""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from billy_dev.ledger import Ledger, utcnow  # noqa: E402

T = [
    # id, phase, title, deps, reqs, tests
    ("p0-env", "P0", "Environment discovery report", [], ["REQ-04", "REQ-11"], ["T-BOOT-03"]),
    ("p0-continuation", "P0", "Prove build continuation", [], ["REQ-02"], ["T-BOOT-02", "T-BOOT-06"]),
    ("p0-manifest", "P0", "Freeze requirement manifest", [], ["REQ-32"], []),
    ("p0-foundation", "P0", "Foundation audit + pin (OpenClaw, Cua)", [], ["REQ-03", "REQ-33"], ["T-FOUND-01", "T-FOUND-02", "T-FOUND-05"]),
    ("p0-threat", "P0", "Initial threat model", ["p0-foundation"], ["REQ-10", "REQ-15"], []),
    ("p0-setup-packet", "P0", "Consolidated setup packet", ["p0-foundation"], ["REQ-01", "REQ-06", "REQ-18"], ["T-BOOT-04", "T-BOOT-05"]),
    ("p1-contracts", "P1", "Action envelope, tool registry, state machines", ["p0-foundation"], ["REQ-05"], ["T-ACTION-01", "T-ACTION-02"]),
    ("p1-store", "P1", "SQLite store, migrations, single writer", ["p1-contracts"], ["REQ-13"], ["T-DUR-09"]),
    ("p1-broker-file", "P1", "Broker + file tools first real slice", ["p1-store"], ["REQ-05", "REQ-09", "REQ-10"], ["T-ACTION-04", "T-SEC-04"]),
    ("p1-native-probe", "P1", "Early native control probe", ["p0-foundation"], ["REQ-11"], ["T-FOUND-03"]),
    ("p2-spine", "P2", "Scheduler, journal, inbox/outbox, cancellation, claims, budget, reconciliation", ["p1-broker-file"], ["REQ-07", "REQ-08", "REQ-18", "REQ-27", "REQ-35"], []),
    ("p2-backup", "P2", "Backup/restore/corruption handling", ["p1-store"], ["REQ-14"], ["T-DUR-10", "T-REL-04"]),
    ("p3-native-app", "P3", "Billy.app shell, LaunchAgent, onboarding, stop", ["p2-spine"], ["REQ-26", "REQ-30"], []),
    ("p3-desktop", "P3", "Cua adapter, desktop lease, takeover yield", ["p2-spine", "p1-native-probe"], ["REQ-11", "REQ-12"], []),
    ("p4-autonomy", "P4", "Provider adapters, planner loop, recovery, context reconstruction", ["p2-spine"], ["REQ-16", "REQ-17"], []),
    ("p5-agents", "P5", "Child runs, worktrees, sandbox containment", ["p2-spine", "p4-autonomy"], ["REQ-19", "REQ-20", "REQ-10"], []),
    ("p6-memory", "P6", "Provenance-aware memory", ["p1-store"], ["REQ-21", "REQ-22"], []),
    ("p6-remote", "P6", "Authenticated phone path + notifications", ["p2-spine"], ["REQ-23", "REQ-24", "REQ-28"], []),
    ("p6-voice", "P6", "Push-to-talk", ["p3-native-app"], ["REQ-25"], []),
    ("p7-e2e", "P7", "Workflows A-F integrated", ["p3-native-app", "p3-desktop", "p4-autonomy", "p5-agents", "p6-memory", "p6-remote", "p6-voice"], ["REQ-04"], []),
    ("p8-qualify", "P8", "Fault/security/concurrency/soak qualification", ["p7-e2e"], ["REQ-29"], []),
    ("p9-package", "P9", "Package, install, update/rollback, uninstall, runbooks", ["p7-e2e"], ["REQ-30", "REQ-31", "REQ-36"], []),
    ("p10-release", "P10", "Evaluator, independent audit, delivery", ["p8-qualify", "p9-package"], ["REQ-32"], []),
]


def main():
    led = Ledger(ROOT / "execution" / "ledger.json")
    digest = hashlib.sha256((ROOT / "BILLY_MASTER_HANDOFF.md").read_bytes()).hexdigest()
    tasks = {}
    for tid, phase, title, deps, reqs, tests in T:
        tasks[tid] = {"task_id": tid, "phase": phase, "title": title, "dependencies": deps,
                      "requirement_ids": reqs, "acceptance_ids": tests,
                      "status": "READY" if not deps else "BLOCKED_DEPENDENCY",
                      "owner_worker": None, "lease_generation": 0, "branch": "main",
                      "base_commit": None, "head_commit": None, "test_evidence": None,
                      "review_evidence": None, "blockers": [], "next_action": title,
                      "budget_scope": "no-cost-local", "updated_at": utcnow()}
    led.init({"project_id": "billy", "handoff_version": "1.0", "handoff_digest": digest,
              "tasks": tasks, "events": []})
    print(f"seeded {len(tasks)} tasks")


if __name__ == "__main__":
    main()
