#!/usr/bin/env python3
"""Tests for `fleet` CLI help and validation.

Hermetic: mock sys.argv, capture stdout/stderr, and verify help and error conditions.
Run with: python3 fleet-cli/help_test.py
"""
import io
import sys
import unittest
from pathlib import Path

# Add fleet-cli to sys.path so we can import modules
sys.path.append(str(Path(__file__).parent))

# We will import fleet_help, which we are about to create.
try:
    import fleet_help
except ImportError:
    fleet_help = None


class TestHelpAndValidation(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(fleet_help, "fleet_help module must exist to run these tests.")

    def run_parser(self, args):
        """Helper to run the parser with captured stdout/stderr.
        
        Returns (exit_code, stdout_str, stderr_str).
        """
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        sys.stdout = io.StringIO()
        sys.stderr = io.StringIO()
        
        exit_code = 0
        try:
            fleet_help.parse_args(args)
        except SystemExit as e:
            exit_code = e.code
        except Exception as e:
            sys.stderr.write(str(e))
            exit_code = 1
        finally:
            stdout_str = sys.stdout.getvalue()
            stderr_str = sys.stderr.getvalue()
            sys.stdout = old_stdout
            sys.stderr = old_stderr
            
        return exit_code, stdout_str, stderr_str

    def test_given_bare_help_when_called_then_prints_main_help_and_exits_0(self):
        """Behavior: Given bare '--help', it prints the general usage with all top-level commands and exits 0."""
        code, out, err = self.run_parser(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("Available commands", out)
        self.assertIn("task", out)
        self.assertIn("epic", out)
        self.assertIn("xtools", out)

    def test_given_task_help_when_called_then_prints_task_help_and_exits_0(self):
        """Behavior: Given 'task --help', it prints task subcommand help and exits 0."""
        code, out, err = self.run_parser(["task", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("Manage cards/tasks on the board", out)
        self.assertIn("create", out)
        self.assertIn("ls", out)

    def test_given_task_create_help_when_called_then_prints_flags_and_exits_0(self):
        """Behavior: Given 'task create --help', it prints create sub-arguments and exits 0."""
        code, out, err = self.run_parser(["task", "create", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("--prompt", out)
        self.assertIn("--repo", out)
        self.assertIn("--agent", out)

    def test_given_epic_create_help_when_called_then_prints_epic_create_arguments_and_exits_0(self):
        """Behavior: Given 'epic create --help', it prints epic create arguments and exits 0."""
        code, out, err = self.run_parser(["epic", "create", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("name", out)
        self.assertIn("--base", out)

    def test_given_missing_required_argument_when_called_then_exits_non_zero_with_usage(self):
        """Behavior: Given a command missing a required argument, it exits non-zero with error."""
        code, out, err = self.run_parser(["agent", "plan"])
        self.assertNotEqual(code, 0)
        self.assertIn("error: the following arguments are required: ENG-ID", err)


if __name__ == "__main__":
    unittest.main()
