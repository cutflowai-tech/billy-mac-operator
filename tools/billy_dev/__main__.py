"""billy-dev: development delivery tooling (not part of the Billy product)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .ledger import Ledger, utcnow
from .supervisor import run_worker, supervise

REPO = Path(__file__).resolve().parents[2]


def brief(doc: dict) -> str:
    lines = [f"# Billy build recovery brief (projection of ledger, generated {utcnow()})", "",
             f"project={doc.get('project_id')} handoff={doc.get('handoff_version')} "
             f"digest={doc.get('handoff_digest','')[:16]}", ""]
    by = {}
    for tid, t in sorted(doc["tasks"].items()):
        by.setdefault(t["status"], []).append(tid)
    for st in sorted(by):
        lines.append(f"- {st}: {', '.join(by[st])}")
    lines.append("")
    blockers = [(tid, t) for tid, t in sorted(doc["tasks"].items()) if t["status"] == "BLOCKED_EXTERNAL"]
    if blockers:
        lines.append("## External blockers")
        for tid, t in blockers:
            lines.append(f"- {tid}: {'; '.join(t.get('blockers', []))}")
        lines.append("")
    ready = [tid for tid, t in sorted(doc["tasks"].items()) if t["status"] == "READY"]
    lines.append("## Next actionable")
    for tid in ready:
        lines.append(f"- {tid}: {doc['tasks'][tid].get('next_action', doc['tasks'][tid].get('title',''))}")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="billy-dev")
    ap.add_argument("--ledger", default=str(REPO / "execution" / "ledger.json"))
    ap.add_argument("--root", default=str(REPO))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("supervise")
    w = sub.add_parser("worker"); w.add_argument("task"); w.add_argument("gen", type=int)
    sub.add_parser("brief")
    sub.add_parser("status")
    a = ap.parse_args(argv)
    led = Ledger(Path(a.ledger))
    root = Path(a.root)
    if a.cmd == "supervise":
        print(json.dumps(supervise(led, root), indent=2))
        return 0
    if a.cmd == "worker":
        return run_worker(led, root, a.task, a.gen)
    if a.cmd == "brief":
        sys.stdout.write(brief(led.read()))
        return 0
    if a.cmd == "status":
        doc = led.read()
        print(json.dumps({k: v["status"] for k, v in sorted(doc["tasks"].items())}, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
