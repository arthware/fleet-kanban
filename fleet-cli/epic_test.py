#!/usr/bin/env python3
"""Tests for `fleet epic` subcommand — create and complete workflows.

Hermetic: mock git, tRPC calls, and network so we pin command behavior.
Run with: python3 fleet-cli/epic_test.py
"""
import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path
import json
import sys

# Add fleet-cli to sys.path so we can import fleet
sys.path.append(str(Path(__file__).parent))
import fleet

class TestEpicCommand(unittest.TestCase):
    def setUp(self):
        # Setup common config mock
        self.cfg = {
            "kanban_port": 3484,
            "repos": ["my-repo"]
        }
        self.repo_path = Path("/mock/project/my-repo")

    @patch("fleet._resolve_repo")
    @patch("fleet.git_run")
    @patch("fleet.trpc_call")
    @patch("socket.socket")
    def test_given_valid_repo_when_epic_create_then_creates_branch_worktree_registers_and_sets_metadata(
        self, mock_socket, mock_trpc, mock_git, mock_resolve
    ):
        """Behavior: Given a valid repo, when creating an epic, then branch is created, pushed, worktree added, registered and metadata is set."""
        # Arrange (Given)
        mock_resolve.return_value = self.repo_path
        
        # Mock git status check (branch doesn't exist yet locally)
        mock_git_rev_parse = MagicMock(returncode=1)
        mock_git.side_effect = lambda repo, args, check=True: (
            mock_git_rev_parse if args[0] == "rev-parse" else MagicMock(returncode=0, stdout="origin\n")
        )
        
        # Mock board check (board is up)
        mock_sock_inst = MagicMock()
        mock_socket.return_value = mock_sock_inst

        # Mock tRPC add and setEpic responses
        mock_trpc.side_effect = lambda cfg, path, data=None: (
            {"ok": True, "project": {"id": "mock-ws-id"}} if path == "projects.add" else {"ok": True}
        )

        # Act (When)
        res = fleet.epic_create("cool-feature", "my-repo", "production-line", self.cfg)

        # Assert (Then)
        self.assertEqual(res, 0)
        # Verify branch creation and push
        mock_git.assert_any_call(self.repo_path, ["branch", "epic/cool-feature", "production-line"])
        mock_git.assert_any_call(self.repo_path, ["push", "-u", "origin", "epic/cool-feature"])
        # Verify worktree addition
        mock_git.assert_any_call(self.repo_path, ["worktree", "add", unittest.mock.ANY, "epic/cool-feature"])
        # Verify tRPC calls
        mock_trpc.assert_any_call(self.cfg, "projects.add", {"path": unittest.mock.ANY})
        mock_trpc.assert_any_call(self.cfg, "projects.setEpic", {
            "workspaceId": "mock-ws-id",
            "epic": {
                "name": "cool-feature",
                "branch": "epic/cool-feature",
                "base": "production-line"
            }
        })

    @patch("fleet._resolve_repo")
    def test_given_invalid_repo_when_epic_create_then_returns_error(self, mock_resolve):
        """Unit: When target repo is invalid, epic create should fail immediately."""
        # Arrange
        mock_resolve.return_value = None

        # Act
        res = fleet.epic_create("cool-feature", "invalid-repo", "production-line", self.cfg)

        # Assert
        self.assertEqual(res, 1)

    @patch("fleet._resolve_repo")
    @patch("fleet.git_run")
    @patch("socket.socket")
    def test_given_offline_board_when_epic_create_then_returns_error_and_suggests_starting(
        self, mock_socket, mock_git, mock_resolve
    ):
        """Unit: When board is offline during epic create, return error and instructions."""
        # Arrange
        mock_resolve.return_value = self.repo_path
        mock_git.return_value = MagicMock(returncode=0)
        
        # Mock board check failure
        mock_socket.side_effect = Exception("offline")

        # Act
        res = fleet.epic_create("cool-feature", "my-repo", "production-line", self.cfg)

        # Assert
        self.assertEqual(res, 1)

    @patch("fleet._resolve_repo")
    @patch("fleet.git_run")
    @patch("fleet.trpc_call")
    @patch("socket.socket")
    @patch("subprocess.run")
    @patch("pathlib.Path.exists")
    def test_given_running_board_and_epic_when_epic_complete_then_creates_pr_and_archives_workspace(
        self, mock_exists, mock_sub_run, mock_socket, mock_trpc, mock_git, mock_resolve
    ):
        """Behavior: Given a running board and existing epic workspace, completing the epic creates a PR and archives the workspace."""
        # Arrange (Given)
        mock_resolve.return_value = self.repo_path
        mock_exists.return_value = True
        
        # Mock board up
        mock_socket.return_value = MagicMock()
        
        # Mock projects list containing the epic, and projects setEpic success
        mock_projects_payload = {
            "projects": [
                {
                    "id": "epic-ws-id",
                    "path": "/mock/project/cline/epics/my-repo@cool-feature",
                    "epic": {
                        "name": "cool-feature",
                        "branch": "epic/cool-feature",
                        "base": "production-line"
                    }
                }
            ]
        }
        mock_trpc.side_effect = lambda cfg, path, data=None: (
            mock_projects_payload if path == "projects.list" else {"ok": True}
        )

        # Mock gh pr create run
        mock_sub_run.return_value = MagicMock(returncode=0, stdout="https://github.com/mock/pr/1")

        # Act (When)
        res = fleet.epic_complete("cool-feature", "my-repo", self.cfg)

        # Assert (Then)
        self.assertEqual(res, 0)
        # Verify push and gh pr create
        mock_git.assert_any_call(self.repo_path, ["push", "origin", "epic/cool-feature"], check=False)
        mock_sub_run.assert_any_call([
            "gh", "pr", "create",
            "--base", "production-line",
            "--head", "epic/cool-feature",
            "--title", "epic: merge cool-feature to production-line",
            "--body", "Epic workspace integration PR for 'cool-feature'.\n\nThis PR integrates the epic branch epic/cool-feature back into production-line."
        ], cwd=str(self.repo_path), capture_output=True, text=True)
        # Verify archive call via setEpic
        mock_trpc.assert_any_call(self.cfg, "projects.setEpic", {
            "workspaceId": "epic-ws-id",
            "epic": {
                "name": "cool-feature",
                "branch": "epic/cool-feature",
                "base": "production-line",
                "archived": True
            }
        })

    @patch("fleet._resolve_repo")
    @patch("fleet.trpc_call")
    @patch("socket.socket")
    def test_given_nonexistent_epic_when_epic_complete_then_returns_error(
        self, mock_socket, mock_trpc, mock_resolve
    ):
        """Unit: When completing an epic name that has no workspace on the board, return error."""
        # Arrange
        mock_resolve.return_value = self.repo_path
        mock_socket.return_value = MagicMock()
        # Mock empty projects list
        mock_trpc.return_value = {"projects": []}

        # Act
        res = fleet.epic_complete("cool-feature", "my-repo", self.cfg)

        # Assert
        self.assertEqual(res, 1)

    @patch("fleet._resolve_repo")
    @patch("fleet.git_run")
    @patch("fleet.trpc_call")
    @patch("socket.socket")
    def test_given_diverged_epic_when_epic_sync_then_merges_and_pushes_and_reports_commits(
        self, mock_socket, mock_trpc, mock_git, mock_resolve
    ):
        """Behavior: Given a diverged epic workspace, when syncing, we fetch origin/base, perform ff merge (which fails), then a real merge (succeeds), push, and report commits."""
        # Arrange (Given)
        mock_resolve.return_value = self.repo_path
        mock_socket.return_value = MagicMock()
        
        # Mock projects list
        mock_projects_payload = {
            "projects": [
                {
                    "id": "epic-ws-id",
                    "path": "/mock/project/cline/epics/my-repo@cool-feature",
                    "epic": {
                        "name": "cool-feature",
                        "branch": "epic/cool-feature",
                        "base": "production-line"
                    }
                }
            ]
        }
        mock_trpc.return_value = mock_projects_payload

        # Mock git commands
        # 1. symbolic-ref -> epic/cool-feature
        # 2. fetch -> OK
        # 3. rev-parse (old sha) -> "sha1"
        # 4. merge --ff-only -> fails (returncode = 1)
        # 5. merge --no-edit -> succeeds (returncode = 0)
        # 6. rev-parse (new sha) -> "sha2"
        # 7. log -> some commits
        # 8. push -> OK
        mock_git_symbolic_ref = MagicMock(returncode=0, stdout="epic/cool-feature\n")
        mock_git_rev_parse_old = MagicMock(returncode=0, stdout="sha1\n")
        mock_git_ff = MagicMock(returncode=1)
        mock_git_merge = MagicMock(returncode=0)
        mock_git_rev_parse_new = MagicMock(returncode=0, stdout="sha2\n")
        mock_git_log = MagicMock(returncode=0, stdout="sha2 feat: some commit\n")
        
        wt_path = Path("/mock/project/cline/epics/my-repo@cool-feature")

        def git_run_side_effect(repo_path, args, check=True):
            self.assertEqual(repo_path, wt_path)
            if args[0] == "symbolic-ref":
                return mock_git_symbolic_ref
            elif args[0] == "rev-parse":
                if mock_git_ff.called:
                    return mock_git_rev_parse_new
                return mock_git_rev_parse_old
            elif args[0] == "merge" and "--ff-only" in args:
                mock_git_ff.called = True
                return mock_git_ff
            elif args[0] == "merge" and "--no-edit" in args:
                return mock_git_merge
            elif args[0] == "log":
                return mock_git_log
            else:
                return MagicMock(returncode=0, stdout="")

        mock_git_ff.called = False
        mock_git.side_effect = git_run_side_effect

        # Act (When)
        res = fleet.epic_sync("cool-feature", "my-repo", self.cfg)

        # Assert (Then)
        self.assertEqual(res, 0)
        mock_git.assert_any_call(wt_path, ["fetch", "origin", "production-line"])
        mock_git.assert_any_call(wt_path, ["merge", "--ff-only", "origin/production-line"], check=False)
        mock_git.assert_any_call(wt_path, ["merge", "--no-edit", "origin/production-line"], check=False)
        mock_git.assert_any_call(wt_path, ["push", "origin", "epic/cool-feature"])

    @patch("fleet._resolve_repo")
    @patch("fleet.git_run")
    @patch("fleet.trpc_call")
    @patch("socket.socket")
    def test_given_up_to_date_epic_when_epic_sync_then_does_not_commit_and_reports_up_to_date(
        self, mock_socket, mock_trpc, mock_git, mock_resolve
    ):
        """Unit: When syncing an up-to-date epic workspace, ff merge succeeds and old_sha == new_sha, so we print already up to date without push."""
        # Arrange
        mock_resolve.return_value = self.repo_path
        mock_socket.return_value = MagicMock()
        mock_trpc.return_value = {
            "projects": [
                {
                    "id": "epic-ws-id",
                    "path": "/mock/project/cline/epics/my-repo@cool-feature",
                    "epic": {
                        "name": "cool-feature",
                        "branch": "epic/cool-feature",
                        "base": "production-line"
                    }
                }
            ]
        }
        
        wt_path = Path("/mock/project/cline/epics/my-repo@cool-feature")
        mock_git_symbolic_ref = MagicMock(returncode=0, stdout="epic/cool-feature\n")
        mock_git_rev_parse = MagicMock(returncode=0, stdout="sha1\n")
        mock_git_ff = MagicMock(returncode=0)

        def git_run_side_effect(repo_path, args, check=True):
            self.assertEqual(repo_path, wt_path)
            if args[0] == "symbolic-ref":
                return mock_git_symbolic_ref
            elif args[0] == "rev-parse":
                return mock_git_rev_parse
            elif args[0] == "merge" and "--ff-only" in args:
                return mock_git_ff
            else:
                return MagicMock(returncode=0, stdout="")

        mock_git.side_effect = git_run_side_effect

        # Act
        res = fleet.epic_sync("cool-feature", "my-repo", self.cfg)

        # Assert
        self.assertEqual(res, 0)
        mock_git.assert_any_call(wt_path, ["merge", "--ff-only", "origin/production-line"], check=False)
        # Verify push was NOT called since shas matched
        for call in mock_git.call_args_list:
            args = call[0][1]
            self.assertNotIn("push", args)

    @patch("fleet._resolve_repo")
    @patch("fleet.git_run")
    @patch("fleet.trpc_call")
    @patch("socket.socket")
    def test_given_conflicting_epic_when_epic_sync_then_aborts_merge_and_reports_conflicting_files(
        self, mock_socket, mock_trpc, mock_git, mock_resolve
    ):
        """Unit: When syncing results in a conflict, we diff conflicting files, abort the merge, and return non-zero."""
        # Arrange
        mock_resolve.return_value = self.repo_path
        mock_socket.return_value = MagicMock()
        mock_trpc.return_value = {
            "projects": [
                {
                    "id": "epic-ws-id",
                    "path": "/mock/project/cline/epics/my-repo@cool-feature",
                    "epic": {
                        "name": "cool-feature",
                        "branch": "epic/cool-feature",
                        "base": "production-line"
                    }
                }
            ]
        }
        
        wt_path = Path("/mock/project/cline/epics/my-repo@cool-feature")
        mock_git_symbolic_ref = MagicMock(returncode=0, stdout="epic/cool-feature\n")
        mock_git_rev_parse = MagicMock(returncode=0, stdout="sha1\n")
        mock_git_ff = MagicMock(returncode=1)
        mock_git_merge = MagicMock(returncode=1)
        mock_git_diff = MagicMock(returncode=0, stdout="src/conflict.txt\n")

        def git_run_side_effect(repo_path, args, check=True):
            self.assertEqual(repo_path, wt_path)
            if args[0] == "symbolic-ref":
                return mock_git_symbolic_ref
            elif args[0] == "rev-parse":
                return mock_git_rev_parse
            elif args[0] == "merge" and "--ff-only" in args:
                return mock_git_ff
            elif args[0] == "merge" and "--no-edit" in args:
                return mock_git_merge
            elif args[0] == "diff":
                return mock_git_diff
            else:
                return MagicMock(returncode=0, stdout="")

        mock_git.side_effect = git_run_side_effect

        # Act
        res = fleet.epic_sync("cool-feature", "my-repo", self.cfg)

        # Assert
        self.assertEqual(res, 1)
        mock_git.assert_any_call(wt_path, ["merge", "--abort"])

    @patch("fleet._resolve_repo")
    @patch("fleet.git_run")
    @patch("fleet.trpc_call")
    @patch("socket.socket")
    def test_given_wrong_head_branch_when_epic_sync_then_returns_error(
        self, mock_socket, mock_trpc, mock_git, mock_resolve
    ):
        """Unit: When worktree HEAD is on a different branch, epic sync fails to prevent unintended changes."""
        # Arrange
        mock_resolve.return_value = self.repo_path
        mock_socket.return_value = MagicMock()
        mock_trpc.return_value = {
            "projects": [
                {
                    "id": "epic-ws-id",
                    "path": "/mock/project/cline/epics/my-repo@cool-feature",
                    "epic": {
                        "name": "cool-feature",
                        "branch": "epic/cool-feature",
                        "base": "production-line"
                    }
                }
            ]
        }
        
        wt_path = Path("/mock/project/cline/epics/my-repo@cool-feature")
        mock_git_symbolic_ref = MagicMock(returncode=0, stdout="main\n")

        def git_run_side_effect(repo_path, args, check=True):
            if args[0] == "symbolic-ref":
                return mock_git_symbolic_ref
            return MagicMock(returncode=0, stdout="")

        mock_git.side_effect = git_run_side_effect

        # Act
        res = fleet.epic_sync("cool-feature", "my-repo", self.cfg)

        # Assert
        self.assertEqual(res, 1)

if __name__ == "__main__":
    unittest.main()
