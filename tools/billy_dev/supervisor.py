"""Minimal supervised local runner for finite build steps.

The supervisor owns readiness, leases and retry decisions (single owner).
Workers own nothing but executing one admitted step under a lease
generation; their completion is a *proposal* that the supervisor verifies
against the postcondition recorded before launch.
"""
from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .ledger import Ledger, LedgerError, utcnow

MAX_ATTEMPTS = 3


def sha256_file(p: Path) -> str | None:
    if not p.exists():
        return None
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _verify(task: dict[str, Any], root: Path) -> tuple[bool, str]:
    post = task.get("postcondition") or {}
    if post.get("kind") == "file_sha256":
        p = root / post["path"]
        got = sha256_file(p)
        return (got == post["sha256"], f"expected {post['sha256']} got {got}")
    if post.get("kind") == "file_exists":
        p = root / post["path"]
        return (p.exists(), f"exists={p.exists()}")
    return (False, "no postcondition declared; cannot verify")


def launch_worker(ledger: Ledger, task_id: str, root: Path) -> subprocess.Popen | None:
    def admit(doc):
        t = doc["tasks"][task_id]
        if t["status"] != "READY":
            return None
        gen = t.get("lease_generation", 0) + 1
        attempts = t.get("attempts", 0) + 1
        Ledger.transition(doc, task_id, "RUNNING", lease_generation=gen, attempts=attempts,
                          owner_worker=None)
        return gen
    gen = ledger.mutate(admit)
    if gen is None:
        return None
    env = dict(os.environ)
    proc = subprocess.Popen(
        [sys.executable, "-E", "-s", "-m", "billy_dev", "--ledger", str(ledger.path), "--root", str(root),
         "worker", task_id, str(gen)],
        cwd=str(Path(__file__).resolve().parent.parent), env=env)

    def record(doc):
        t = doc["tasks"][task_id]
        if t.get("lease_generation") == gen:
            t["owner_worker"] = {"pid": proc.pid, "generation": gen, "started_at": utcnow()}
            Ledger.event(doc, "worker_launched", task_id=task_id, pid=proc.pid, generation=gen)
    ledger.mutate(record)
    return proc


def settle(ledger: Ledger, task_id: str, root: Path, exit_code: int | None) -> str:
    """Called by the supervisor after a worker exits (or is found dead)."""
    def fn(doc):
        t = doc["tasks"][task_id]
        if t["status"] == "VERIFICATION":
            ok, detail = _verify(t, root)
            if ok:
                Ledger.transition(doc, task_id, "DONE", test_evidence=detail)
                promoted = Ledger.promote_ready(doc)
                Ledger.event(doc, "auto_progression", task_id=task_id, promoted=promoted)
                return "DONE"
            Ledger.transition(doc, task_id, "FAILED_ACTIONABLE", blockers=[f"verification failed: {detail}"])
            return "FAILED_VERIFICATION"
        if t["status"] == "RUNNING":
            # Worker lost without a proposal. Reconcile before any retry:
            # if the postcondition already holds, the effect happened; do not redo it.
            Ledger.event(doc, "worker_lost", task_id=task_id, exit_code=exit_code,
                         generation=t.get("lease_generation"))
            ok, detail = _verify(t, root)
            if ok:
                Ledger.transition(doc, task_id, "VERIFICATION")
                Ledger.transition(doc, task_id, "DONE", test_evidence=f"reconciled after worker loss: {detail}")
                promoted = Ledger.promote_ready(doc)
                Ledger.event(doc, "auto_progression", task_id=task_id, promoted=promoted)
                return "DONE_RECONCILED"
            if t.get("attempts", 0) >= MAX_ATTEMPTS:
                Ledger.transition(doc, task_id, "FAILED_ACTIONABLE", blockers=["attempts exhausted"])
                return "EXHAUSTED"
            Ledger.transition(doc, task_id, "READY", owner_worker=None)
            return "REQUEUED"
        return t["status"]
    return ledger.mutate(fn)


def recover(ledger: Ledger, root: Path) -> list[str]:
    """Startup recovery: any RUNNING task whose worker process is gone is settled."""
    doc = ledger.read()
    out = []
    for tid, t in sorted(doc["tasks"].items()):
        if t["status"] in ("RUNNING", "VERIFICATION"):
            w = t.get("owner_worker") or {}
            pid = w.get("pid")
            alive = False
            if pid:
                try:
                    os.kill(pid, 0)
                    alive = True
                except OSError:
                    alive = False
            if alive:
                # Fence: a live stale worker cannot commit because its generation
                # will no longer match; terminate it before replacement.
                os.kill(pid, signal.SIGTERM)
                time.sleep(0.2)
            out.append(f"{tid}:{settle(ledger, tid, root, None)}")
    return out


def supervise(ledger: Ledger, root: Path, max_steps: int = 100) -> dict[str, Any]:
    ledger.mutate(lambda d: Ledger.event(d, "supervisor_start", pid=os.getpid()))
    recovered = recover(ledger, root)
    ledger.mutate(lambda d: Ledger.promote_ready(d))
    steps = 0
    while steps < max_steps:
        ready = [tid for tid in Ledger.next_ready(ledger.read())
                 if ledger.read()["tasks"][tid].get("command")]
        if not ready:
            break
        tid = ready[0]
        proc = launch_worker(ledger, tid, root)
        if proc is None:
            continue
        code = proc.wait()
        settle(ledger, tid, root, code)
        steps += 1
    doc = ledger.read()
    ledger.mutate(lambda d: Ledger.event(d, "supervisor_idle", pid=os.getpid()))
    return {"recovered": recovered,
            "status": {k: v["status"] for k, v in sorted(doc["tasks"].items())}}


def run_worker(ledger: Ledger, root: Path, task_id: str, gen: int) -> int:
    doc = ledger.read()
    t = doc["tasks"][task_id]
    if t.get("lease_generation") != gen or t["status"] != "RUNNING":
        print(f"fenced: stale generation {gen}", file=sys.stderr)
        return 3
    cmd = t["command"]
    fault = os.environ.get("BILLY_DEV_FAULT", "")
    if fault == f"kill_before:{task_id}:{t.get('attempts')}":
        os.kill(os.getpid(), signal.SIGKILL)
    rc = subprocess.call(cmd, shell=False, cwd=str(root))
    if fault == f"kill_after:{task_id}:{t.get('attempts')}":
        os.kill(os.getpid(), signal.SIGKILL)
    if rc != 0:
        return rc

    def propose(doc):
        tt = doc["tasks"][task_id]
        if tt.get("lease_generation") != gen or tt["status"] != "RUNNING":
            raise LedgerError("fenced at commit")
        Ledger.transition(doc, task_id, "VERIFICATION", head_commit=None)
    try:
        ledger.mutate(propose)
    except LedgerError as e:
        print(str(e), file=sys.stderr)
        return 3
    return 0
