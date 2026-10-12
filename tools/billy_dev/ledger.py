"""Durable development build ledger (BUILD_TASK domain, never BILLY_TASK).

Authoritative state is a single JSON document written atomically
(write temp + fsync + rename + fsync dir) under an exclusive flock.
Human-readable summaries are generated projections of this file.
"""
from __future__ import annotations

import contextlib
import datetime as _dt
import fcntl
import json
import os
from pathlib import Path
from typing import Any, Callable, Iterator

STATES = {"READY", "BLOCKED_DEPENDENCY", "RUNNING", "REVIEW", "INTEGRATION",
          "VERIFICATION", "BLOCKED_EXTERNAL", "FAILED_ACTIONABLE", "DONE"}

# Legal transitions for build tasks. A worker's success only proposes REVIEW
# (or VERIFICATION for fixture/automated steps); DONE requires evidence.
TRANSITIONS = {
    "BLOCKED_DEPENDENCY": {"READY", "BLOCKED_EXTERNAL"},
    "READY": {"RUNNING", "BLOCKED_EXTERNAL"},
    "RUNNING": {"REVIEW", "VERIFICATION", "FAILED_ACTIONABLE", "READY", "BLOCKED_EXTERNAL"},
    "REVIEW": {"INTEGRATION", "FAILED_ACTIONABLE", "VERIFICATION"},
    "INTEGRATION": {"VERIFICATION", "FAILED_ACTIONABLE"},
    "VERIFICATION": {"DONE", "FAILED_ACTIONABLE"},
    "FAILED_ACTIONABLE": {"READY"},
    "BLOCKED_EXTERNAL": {"READY", "BLOCKED_DEPENDENCY"},
    "DONE": set(),
}


def utcnow() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class LedgerError(Exception):
    pass


class Ledger:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock_path = self.path.with_suffix(".lock")

    @contextlib.contextmanager
    def _locked(self) -> Iterator[None]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.lock_path, "a+") as lf:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lf.fileno(), fcntl.LOCK_UN)

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            raise LedgerError(f"ledger missing: {self.path}")
        return json.loads(self.path.read_text("utf-8"))

    def _write(self, doc: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(".tmp")
        data = json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)
        dfd = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)

    def read(self) -> dict[str, Any]:
        with self._locked():
            return self._read()

    def init(self, doc: dict[str, Any], overwrite: bool = False) -> None:
        with self._locked():
            if self.path.exists() and not overwrite:
                raise LedgerError("ledger exists; refusing to overwrite")
            doc.setdefault("events", [])
            doc.setdefault("tasks", {})
            self._write(doc)

    def mutate(self, fn: Callable[[dict[str, Any]], Any]) -> Any:
        with self._locked():
            doc = self._read()
            result = fn(doc)
            self._write(doc)
            return result

    # ---- helpers used inside mutate() callbacks ----
    @staticmethod
    def event(doc: dict[str, Any], kind: str, **fields: Any) -> None:
        seq = (doc["events"][-1]["seq"] + 1) if doc["events"] else 1
        doc["events"].append({"seq": seq, "at": utcnow(), "kind": kind, **fields})

    @staticmethod
    def transition(doc: dict[str, Any], task_id: str, to: str, **fields: Any) -> None:
        t = doc["tasks"][task_id]
        frm = t["status"]
        if to not in STATES:
            raise LedgerError(f"unknown state {to}")
        if to not in TRANSITIONS[frm]:
            raise LedgerError(f"illegal transition {task_id}: {frm} -> {to}")
        t["status"] = to
        t["updated_at"] = utcnow()
        t.update(fields)
        Ledger.event(doc, "transition", task_id=task_id, frm=frm, to=to)

    @staticmethod
    def promote_ready(doc: dict[str, Any]) -> list[str]:
        """Dependency-driven automatic progression: any BLOCKED_DEPENDENCY task
        whose dependencies are all DONE becomes READY. Returns promoted ids."""
        promoted = []
        for tid, t in sorted(doc["tasks"].items()):
            if t["status"] == "BLOCKED_DEPENDENCY" and all(
                    doc["tasks"][d]["status"] == "DONE" for d in t.get("dependencies", [])):
                Ledger.transition(doc, tid, "READY")
                promoted.append(tid)
        return promoted

    @staticmethod
    def next_ready(doc: dict[str, Any]) -> list[str]:
        return [tid for tid, t in sorted(doc["tasks"].items()) if t["status"] == "READY"]
