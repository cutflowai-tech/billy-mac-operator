"""T-BOOT-02 / T-BOOT-06: builder recovery and automatic phase progression.

Real processes, real SIGKILLs, real files. No owner message is involved:
recovery is driven solely by the persisted ledger.
"""
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOLS = REPO / "tools"
STEP = r'''
import hashlib, sys, time, os
n = int(sys.argv[1]); out = sys.argv[2]; delay = float(sys.argv[3])
prev = open(os.path.join(out, f"step-{n-1}.txt")).read() if n > 1 else "genesis"
content = f"step-{n}:" + hashlib.sha256(prev.encode()).hexdigest()
target = os.path.join(out, f"step-{n}.txt")
time.sleep(delay)
if not (os.path.exists(target) and open(target).read() == content):
    # The externally visible effect: one line per real execution.
    with open(os.path.join(out, "effects.log"), "a") as f:
        f.write(f"step-{n}\n"); f.flush(); os.fsync(f.fileno())
    tmp = target + ".tmp"
    with open(tmp, "w") as f:
        f.write(content); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, target)
'''


def expected_chain(n):
    prev, out = "genesis", []
    for i in range(1, n + 1):
        c = f"step-{i}:" + hashlib.sha256(prev.encode()).hexdigest()
        out.append(c)
        prev = c
    return out


def make_ledger(root: Path, delays=(0, 0, 0)):
    (root / "step.py").write_text(STEP)
    chain = expected_chain(3)
    tasks = {}
    for i in range(1, 4):
        tasks[f"fx-{i}"] = {
            "task_id": f"fx-{i}", "title": f"fixture step {i}", "phase": f"FX{i}",
            "dependencies": [f"fx-{i-1}"] if i > 1 else [],
            "status": "BLOCKED_DEPENDENCY" if i > 1 else "READY",
            "command": [sys.executable, "-I", str(root / "step.py"), str(i), str(root), str(delays[i-1])],
            "postcondition": {"kind": "file_sha256", "path": f"step-{i}.txt",
                              "sha256": hashlib.sha256(chain[i-1].encode()).hexdigest()},
            "requirement_ids": ["REQ-02"], "acceptance_ids": ["T-BOOT-02", "T-BOOT-06"],
            "budget_scope": "no-cost-local",
        }
    # An independent task with no command (e.g. waiting on an external blocker)
    tasks["ext-1"] = {"task_id": "ext-1", "title": "needs owner credential", "dependencies": [],
                      "status": "BLOCKED_EXTERNAL", "blockers": ["fixture external blocker"]}
    doc = {"project_id": "billy-fixture", "handoff_version": "1.0", "handoff_digest": "fixture",
           "tasks": tasks, "events": []}
    (root / "ledger.json").write_text(json.dumps(doc))
    return root / "ledger.json"


def run_supervisor(ledger, root, env_extra=None, background=False):
    env = dict(os.environ, PYTHONPATH=str(TOOLS), **(env_extra or {}))
    args = [sys.executable, "-E", "-s", "-m", "billy_dev", "--ledger", str(ledger), "--root", str(root), "supervise"]
    # -I ignores PYTHONPATH, so run from the tools directory.
    if background:
        return subprocess.Popen(args, cwd=str(TOOLS), env=env, start_new_session=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return subprocess.run(args, cwd=str(TOOLS), env=env, capture_output=True, text=True, timeout=120)


class BuildContinuation(unittest.TestCase):
    def check_final(self, root, ledger):
        doc = json.loads(ledger.read_text())
        for i in range(1, 4):
            self.assertEqual(doc["tasks"][f"fx-{i}"]["status"], "DONE")
        self.assertEqual(doc["tasks"]["ext-1"]["status"], "BLOCKED_EXTERNAL")
        effects = (root / "effects.log").read_text().split()
        self.assertEqual(sorted(effects), ["step-1", "step-2", "step-3"], "duplicate or lost effect")
        chain = expected_chain(3)
        for i in range(1, 4):
            self.assertEqual((root / f"step-{i}.txt").read_text(), chain[i-1])
        kinds = [e["kind"] for e in doc["events"]]
        self.assertIn("auto_progression", kinds)
        return doc

    def test_worker_killed_after_effect_is_reconciled_not_repeated(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); led = make_ledger(root)
            r = run_supervisor(led, root, {"BILLY_DEV_FAULT": "kill_after:fx-2:1"})
            self.assertEqual(r.returncode, 0, r.stderr)
            doc = self.check_final(root, led)
            self.assertEqual(doc["tasks"]["fx-2"]["attempts"], 1)
            self.assertIn("reconciled", doc["tasks"]["fx-2"]["test_evidence"])
            self.assertTrue(any(e["kind"] == "worker_lost" and e["task_id"] == "fx-2" for e in doc["events"]))

    def test_worker_killed_before_effect_is_requeued_same_identity(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); led = make_ledger(root)
            r = run_supervisor(led, root, {"BILLY_DEV_FAULT": "kill_before:fx-3:1"})
            self.assertEqual(r.returncode, 0, r.stderr)
            doc = self.check_final(root, led)
            self.assertEqual(doc["tasks"]["fx-3"]["attempts"], 2)
            self.assertEqual(doc["tasks"]["fx-3"]["lease_generation"], 2)

    def test_lead_supervisor_killed_and_recreated_from_ledger_only(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); led = make_ledger(root, delays=(0, 3, 0))
            p = run_supervisor(led, root, background=True)
            deadline = time.time() + 20
            while time.time() < deadline:
                doc = json.loads(led.read_text())
                if doc["tasks"]["fx-2"]["status"] == "RUNNING" and doc["tasks"]["fx-2"].get("owner_worker"):
                    break
                time.sleep(0.05)
            else:
                self.fail("fx-2 never started")
            os.killpg(p.pid, signal.SIGKILL)  # kills lead supervisor AND its worker
            p.wait()
            self.assertEqual(json.loads(led.read_text())["tasks"]["fx-2"]["status"], "RUNNING")
            r = run_supervisor(led, root)  # brand-new process, state only from ledger
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertTrue(any(x.startswith("fx-2:") for x in out["recovered"]))
            doc = self.check_final(root, led)
            starts = [e for e in doc["events"] if e["kind"] == "supervisor_start"]
            self.assertEqual(len(starts), 2)
            self.assertNotEqual(starts[0]["pid"], starts[1]["pid"])

    def test_illegal_transition_rejected(self):
        sys.path.insert(0, str(TOOLS))
        from billy_dev.ledger import Ledger, LedgerError
        with tempfile.TemporaryDirectory() as d:
            root = Path(d); led = Ledger(make_ledger(root))
            with self.assertRaises(LedgerError):
                led.mutate(lambda doc: Ledger.transition(doc, "fx-1", "DONE"))
            self.assertEqual(led.read()["tasks"]["fx-1"]["status"], "READY")


if __name__ == "__main__":
    unittest.main(verbosity=2)
