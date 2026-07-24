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
    def test_given_running_board_and_epic_when_epic_complete_then_creates_pr_and_deregisters_and_removes_worktree(
        self, mock_exists, mock_sub_run, mock_socket, mock_trpc, mock_git, mock_resolve
    ):
        """Behavior: Given a running board and existing epic workspace, completing the epic creates a PR, removes worktree and deregisters."""
        # Arrange (Given)
        mock_resolve.return_value = self.repo_path
        mock_exists.return_value = True
        
        # Mock board up
        mock_socket.return_value = MagicMock()
        
        # Mock projects list containing the epic, and projects remove success
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
        # Verify deregistration
        mock_trpc.assert_any_call(self.cfg, "projects.remove", {"projectId": "epic-ws-id"})
        # Verify worktree removal
        mock_git.assert_any_call(self.repo_path, ["worktree", "remove", "--force", "/mock/project/cline/epics/my-repo@cool-feature"], check=False)

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

if __name__ == "__main__":
    unittest.main()
