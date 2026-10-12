#!/usr/bin/env python3
"""Freeze the Billy requirement + acceptance manifest from the master handoff.

Parses sections 23 (requirement register) and 24 (acceptance catalog) of
BILLY_MASTER_HANDOFF.md and writes release/requirements.manifest.json.
Fails nonzero unless exactly 36 requirements and 104 mandatory scenarios
are found, every scenario references only known requirements, and every
requirement is covered by at least one scenario.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HANDOFF = ROOT / "BILLY_MASTER_HANDOFF.md"
OUT = ROOT / "release" / "requirements.manifest.json"

LANES = {"UNIT", "CONTRACT", "INTEGRATION", "NATIVE_LIVE", "PROVIDER_LIVE",
         "REMOTE_LIVE", "FAULT", "SECURITY", "PACKAGE"}


def main() -> int:
    raw = HANDOFF.read_bytes()
    text = raw.decode("utf-8")
    reqs = []
    for m in re.finditer(r"^\| (REQ-\d\d) \| ([^|]+) \| ([^|]+) \|$", text, re.M):
        reqs.append({"id": m.group(1), "title": m.group(2).strip(),
                     "acceptance_intent": m.group(3).strip()})
    tests = []
    pat = re.compile(
        r"^\*\*(T-[A-Z]+-\d\d) — (.+?)\*\*\s*\n"
        r"Requirements: ([^.]+)\. Lane: `([A-Z_]+)`\. (Mandatory)\.\s*\n"
        r"\*\*Setup:\*\* (.+?) \*\*Procedure:\*\* (.+?) \*\*Pass condition:\*\* (.+?) \*\*Evidence:\*\* (.+?)$",
        re.M)
    for m in pat.finditer(text):
        tests.append({
            "id": m.group(1), "title": m.group(2).strip(),
            "requirements": [r.strip() for r in m.group(3).split(",")],
            "lane": m.group(4), "mandatory": True,
            "setup": m.group(6).strip(), "procedure": m.group(7).strip(),
            "pass_condition": m.group(8).strip(), "evidence": m.group(9).strip(),
            "status": "SPECIFIED_NOT_EXECUTED",
        })
    errors = []
    req_ids = [r["id"] for r in reqs]
    test_ids = [t["id"] for t in tests]
    if len(reqs) != 36 or len(set(req_ids)) != 36:
        errors.append(f"expected 36 unique requirements, found {len(reqs)}")
    if len(tests) != 104 or len(set(test_ids)) != 104:
        errors.append(f"expected 104 unique scenarios, found {len(tests)}")
    covered = set()
    for t in tests:
        if t["lane"] not in LANES:
            errors.append(f"{t['id']}: unknown lane {t['lane']}")
        for r in t["requirements"]:
            if r not in req_ids:
                errors.append(f"{t['id']}: unknown requirement {r}")
            covered.add(r)
    for r in req_ids:
        if r not in covered:
            errors.append(f"{r}: no covering scenario")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    manifest = {
        "schema_version": 1,
        "project": "Billy",
        "handoff_version": "1.0",
        "handoff_sha256": hashlib.sha256(raw).hexdigest(),
        "requirements": reqs,
        "tests": tests,
        "gates": {
            "state_machine_sequences_min": 1000,
            "crash_boundaries_min": 12, "injections_per_boundary_min": 10,
            "native_distinct_scenarios_min": 8, "native_consecutive_runs": 3,
            "real_autonomy_actions_min": 10,
            "multi_agent_concurrent_workers_min": 2,
            "local_stop_ack_seconds_max": 2.0,
            "human_takeover_suppression_ms_max": 500,
            "active_soak_minutes_min": 60, "active_soak_tasks_min": 20,
        },
    }
    body = json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    OUT.write_text(body, encoding="utf-8")
    digest = hashlib.sha256(body.encode()).hexdigest()
    (OUT.parent / "requirements.manifest.sha256").write_text(f"{digest}  requirements.manifest.json\n")
    print(f"frozen: {len(reqs)} requirements, {len(tests)} scenarios; manifest sha256 {digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
