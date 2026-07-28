#!/usr/bin/env python3
"""Tests for `fleet` CLI help and validation.

Hermetic and dynamic: runs tests against `fleet_help.py` which dynamically
delegates to the underlying CLI parsers (such as `fleet.py` and the kanban binary).
"""
import io
import sys
import unittest
from pathlib import Path

# Add fleet-cli to sys.path so we can import modules
sys.path.append(str(Path(__file__).parent))

import fleet_help


class TestHelpAndValidation(unittest.TestCase):
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
        self.assertIn("usage: fleet", out)
        self.assertIn("task", out)
        self.assertIn("epic", out)
        self.assertIn("xtools", out)

    def test_given_task_help_when_called_then_prints_task_help_and_exits_0(self):
        """Behavior: Given 'task --help', it prints task subcommand help and exits 0."""
        code, out, err = self.run_parser(["task", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("list", out)
        self.assertIn("create", out)
        self.assertIn("promote", out)

    def test_given_task_create_help_when_called_then_prints_flags_and_exits_0(self):
        """Behavior: Given 'task create --help', it prints create sub-arguments and exits 0."""
        code, out, err = self.run_parser(["task", "create", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("--prompt", out)
        self.assertIn("--file", out)
        self.assertIn("--markdown", out)

    def test_given_epic_create_help_when_called_then_prints_epic_create_arguments_and_exits_0(self):
        """Behavior: Given 'epic create --help', it prints epic create arguments and exits 0."""
        code, out, err = self.run_parser(["epic", "create", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("name", out)
        self.assertIn("--base", out)

    def test_given_task_create_help_when_called_then_contains_real_accepted_flags_from_kanban_binary(self):
        """Behavior: Given 'task create --help', it derives help from the real kanban binary and contains its exact options."""
        code, out, err = self.run_parser(["task", "create", "--help"])
        self.assertEqual(code, 0)
        self.assertIn("--agent-id", out)
        self.assertIn("--external-issue", out)
        self.assertIn("--prompt", out)

    def test_given_missing_required_argument_on_real_cli_parser_then_exits_non_zero_with_usage(self):
        """Behavior: Given missing arguments to underlying python CLI parser (e.g. fleet.py epic create), it exits non-zero."""
        import subprocess
        fleet_py = Path(__file__).parent / "fleet.py"
        r = subprocess.run([sys.executable, str(fleet_py), "epic", "create"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("required", r.stderr)


if __name__ == "__main__":
    unittest.main()
