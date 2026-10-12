"""T-BOOT-01: bootstrap preserves dirty tracked files, untracked owner files and existing docs."""
import hashlib, json, os, subprocess, tempfile, unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def git(cwd, *a): return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=cwd, capture_output=True, text=True, check=True).stdout

class Bootstrap(unittest.TestCase):
    def test_T_BOOT_01_workspace_preservation(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d) / "Billy"; ws.mkdir()
            git(ws, "init", "-q", "-b", "feature/owner-work")
            (ws / "tracked.txt").write_text("v1\n"); (ws / "docs").mkdir(); (ws / "docs" / "adr").mkdir()
            (ws / "docs" / "adr" / "0001-owner.md").write_text("owner decision\n")
            git(ws, "add", "-A"); git(ws, "commit", "-qm", "owner base")
            (ws / "tracked.txt").write_text("v2 uncommitted owner edit\n")          # dirty tracked change
            (ws / "owner-notes.txt").write_text("untracked owner file\n")           # untracked owner file
            files = ["tracked.txt", "owner-notes.txt", "docs/adr/0001-owner.md"]
            before = {f: sha(ws / f) for f in files}
            status_before = git(ws, "status", "--porcelain")
            diff_before = git(ws, "diff")
            head_before = git(ws, "rev-parse", "HEAD")
            out = subprocess.run([str(REPO / "tools" / "bootstrap.sh"), str(ws)], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual({f: sha(ws / f) for f in files}, before)
            self.assertEqual(git(ws, "diff"), diff_before)
            self.assertEqual(git(ws, "rev-parse", "HEAD"), head_before)
            self.assertEqual(git(ws, "symbolic-ref", "--short", "HEAD").strip(), "feature/owner-work")
            # Only additions: the bootstrap record (untracked) on top of the original status.
            added = [l for l in git(ws, "status", "--porcelain").splitlines() if l not in status_before.splitlines()]
            self.assertTrue(all("execution/" in l for l in added), added)
            rec = json.loads(next((ws / "execution").glob("bootstrap-*.json")).read_text())
            self.assertEqual(rec["branch"], "feature/owner-work")
            self.assertEqual(rec["dirty_entries_preserved"], 2)
            # Running again is idempotent and still non-destructive.
            subprocess.run([str(REPO / "tools" / "bootstrap.sh"), str(ws)], check=True, capture_output=True)
            self.assertEqual({f: sha(ws / f) for f in files}, before)

if __name__ == "__main__":
    unittest.main(verbosity=2)
