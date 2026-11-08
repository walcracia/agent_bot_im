"""用临时本地 bare remote 验证同步和保留工作区的行为，不访问网络。"""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("sync_project.py")


class SyncProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="proj-multihandoff-sync-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.remote = self.base / "remote.git"
        self.seed = self.base / "seed"
        self.project = self.base / "project"
        self.git(self.base, "init", "--bare", "--initial-branch=main", str(self.remote))
        self.git(self.base, "init", "--initial-branch=main", str(self.seed))
        self.commit(self.seed, "initial")
        self.git(self.seed, "remote", "add", "origin", str(self.remote))
        self.git(self.seed, "push", "-u", "origin", "main")

    def git(self, cwd, *args):
        result = subprocess.run(
            ["git", "-C", str(cwd), "-c", "user.name=Sync Test", "-c", "user.email=sync-test@example.invalid", *args],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def commit(self, repo, text):
        (repo / "data.txt").write_text(text + "\n", encoding="utf-8")
        self.git(repo, "add", "--", "data.txt")
        self.git(repo, "commit", "-m", text)
        return self.git(repo, "rev-parse", "HEAD")

    def run_sync(self, project=None, address=None, success=True, use_cwd=False):
        args = [sys.executable, str(SCRIPT)]
        if not use_cwd:
            args += ["--project", str(project or self.project)]
        if address is not None:
            args += ["--git-url", str(address)]
        result = subprocess.run(
            args, capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=str(project or self.project) if use_cwd else None,
        )
        self.assertEqual(result.returncode, 0 if success else 2, result.stdout + result.stderr)
        return json.loads(result.stdout) if success else result.stderr

    def clone(self):
        return self.run_sync(address=self.remote)

    def test_clone_then_pull_without_url(self):
        first = self.clone()
        self.assertEqual(first["action"], "cloned")
        updated = self.commit(self.seed, "remote update")
        self.git(self.seed, "push", "origin", "main")
        second = self.run_sync(use_cwd=True)
        self.assertEqual(second["action"], "pulled")
        self.assertEqual(second["head"], updated)
        self.assertEqual((self.project / "data.txt").read_text(encoding="utf-8"), "remote update\n")

    def test_first_use_requires_address(self):
        self.assertIn("--git-url", self.run_sync(success=False))
        self.assertFalse(self.project.exists())

    def test_dirty_tracked_file_is_preserved(self):
        self.clone()
        head = self.git(self.project, "rev-parse", "HEAD")
        content = "local work must remain\n"
        (self.project / "data.txt").write_text(content, encoding="utf-8")
        self.assertIn("未提交", self.run_sync(success=False))
        self.assertEqual((self.project / "data.txt").read_text(encoding="utf-8"), content)
        self.assertEqual(self.git(self.project, "rev-parse", "HEAD"), head)
        self.assertEqual(self.git(self.project, "stash", "list"), "")

    def test_untracked_file_is_preserved(self):
        self.clone()
        local = self.project / "local.txt"
        local.write_text("untracked", encoding="utf-8")
        self.assertIn("未跟踪", self.run_sync(success=False))
        self.assertEqual(local.read_text(encoding="utf-8"), "untracked")

    def test_nonempty_target_is_preserved(self):
        self.project.mkdir()
        local = self.project / "local.txt"
        local.write_text("existing", encoding="utf-8")
        self.assertIn("非空", self.run_sync(address=self.remote, success=False))
        self.assertEqual(local.read_text(encoding="utf-8"), "existing")

    def test_remote_mismatch_does_not_change_origin(self):
        self.clone()
        self.assertIn("origin 不符", self.run_sync(address=self.base / "different.git", success=False))
        self.assertEqual(self.git(self.project, "remote", "get-url", "origin"), str(self.remote))

    def test_detached_head_is_preserved(self):
        self.clone()
        head = self.git(self.project, "rev-parse", "HEAD")
        self.git(self.project, "checkout", "--detach", head)
        self.assertIn("detached HEAD", self.run_sync(success=False))
        self.assertEqual(self.git(self.project, "rev-parse", "HEAD"), head)

    def test_no_upstream_is_rejected(self):
        self.clone()
        self.git(self.project, "branch", "--unset-upstream")
        self.assertIn("upstream", self.run_sync(success=False))

    def test_no_origin_is_rejected(self):
        self.clone()
        self.git(self.project, "remote", "rename", "origin", "upstream")
        self.assertIn("没有 origin", self.run_sync(success=False))

    def test_empty_remote_does_not_claim_synced(self):
        empty = self.base / "empty.git"
        self.git(self.base, "init", "--bare", "--initial-branch=main", str(empty))
        self.assertIn("还没有提交", self.run_sync(address=empty, success=False))

    def test_nested_clone_does_not_change_parent_repo(self):
        self.clone()
        head = self.git(self.project, "rev-parse", "HEAD")
        nested = self.project / "nested"
        self.assertIn("另一个 Git 仓库", self.run_sync(project=nested, address=self.remote, success=False))
        self.assertFalse(nested.exists())
        self.assertEqual(self.git(self.project, "rev-parse", "HEAD"), head)

    def test_unborn_repository_is_rejected(self):
        self.git(self.base, "init", "--initial-branch=main", str(self.project))
        self.assertIn("还没有提交", self.run_sync(success=False))

    def test_divergence_preserves_both_histories(self):
        self.clone()
        local_head = self.commit(self.project, "local change")
        remote_head = self.commit(self.seed, "remote change")
        self.git(self.seed, "push", "origin", "main")
        self.assertIn("分叉", self.run_sync(success=False))
        self.assertEqual(self.git(self.project, "rev-parse", "HEAD"), local_head)
        self.assertEqual(self.git(self.project, "rev-parse", "origin/main"), remote_head)
        self.assertEqual((self.project / "data.txt").read_text(encoding="utf-8"), "local change\n")

    def test_local_ahead_is_reported_without_push(self):
        original = self.clone()["head"]
        local_head = self.commit(self.project, "local change")
        result = self.run_sync()
        self.assertEqual(result["head"], local_head)
        self.assertEqual(result["local_commits_ahead"], 1)
        self.assertEqual(self.git(self.remote, "rev-parse", "main"), original)

    def test_subdirectory_does_not_operate_parent_repo(self):
        self.clone()
        child = self.project / "child"
        child.mkdir()
        self.assertIn("不是 Git 根", self.run_sync(project=child, success=False))

    def test_linked_worktree_preserves_branch_selection(self):
        self.clone()
        linked = self.base / "linked"
        self.git(self.project, "worktree", "add", "--track", "-b", "handoff", str(linked), "origin/main")
        result = self.run_sync(project=linked)
        self.assertEqual(result["branch"], "handoff")
        self.assertEqual(result["worktree_count"], 2)
        self.assertEqual(self.git(self.project, "branch", "--show-current"), "main")

    def test_embedded_http_credentials_are_not_echoed(self):
        secret = "https://test-secret-token@example.invalid/repo.git"
        result = self.run_sync(address=secret, success=False)
        self.assertIn("HTTP 凭证", result)
        self.assertNotIn("test-secret-token", result)
        self.assertFalse(self.project.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
