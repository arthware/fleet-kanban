#!/usr/bin/env python3
"""Tests for `fleet card-type` subcommand.

Run with: python3 fleet-cli/card_type_test.py
"""
import unittest
import subprocess
import tempfile
import shutil
from pathlib import Path

class TestCardTypeCommand(unittest.TestCase):
    def setUp(self):
        # Create a temporary directory to act as a fleet project
        self.temp_dir = tempfile.mkdtemp()
        self.project_path = Path(self.temp_dir)
        self.fleet_dir = self.project_path / ".fleet"
        self.fleet_dir.mkdir()
        
        # Write dummy config.json so fleet recognizes it as a project
        with open(self.fleet_dir / "config.json", "w") as f:
            f.write('{"repos": []}')

        # Resolve path to fleet CLI script
        self.fleet_script = str(Path(__file__).parent.parent / "fleet-cli" / "fleet")

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def run_fleet(self, args, check=True):
        import os
        env = dict(os.environ)
        root_dir = str(Path(__file__).parent.parent)
        env["FLEET_REPO"] = root_dir
        env["KANBAN_SOURCE"] = root_dir
        # Run fleet script inside our temp project directory
        res = subprocess.run(
            [self.fleet_script] + args,
            cwd=self.temp_dir,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env
        )
        if check and res.returncode != 0:
            print(f"STDOUT:\n{res.stdout}")
            print(f"STDERR:\n{res.stderr}")
            self.fail(f"Command {' '.join(args)} failed with exit code {res.returncode}")
        return res

    def test_given_card_type_ls_then_lists_feature_manifest(self):
        """Behavior: `fleet card-type ls` lists built-in feature manifest."""
        res = self.run_fleet(["card-type", "ls"])
        self.assertIn("build", res.stdout)
        self.assertIn("The default card workflow", res.stdout)

    def test_given_card_type_new_then_scaffolds_and_lists_it(self):
        """Behavior: `fleet card-type new` scaffolds a manifest, and `fleet card-type ls` lists it."""
        # Create a new card type
        res_new = self.run_fleet(["card-type", "new", "test-type"])
        self.assertIn("created", res_new.stdout)
        self.assertIn("test-type.md", res_new.stdout)

        # Check that it exists on disk
        manifest_path = self.project_path / "fleet" / "card-types" / "test-type.md"
        self.assertTrue(manifest_path.exists())

        # Verify that card-type ls lists it
        res_ls = self.run_fleet(["card-type", "ls"])
        self.assertIn("test-type", res_ls.stdout)
        self.assertIn("A custom card workflow for test-type tasks", res_ls.stdout)

        # Verify that card-type show prints it
        res_show = self.run_fleet(["card-type", "show", "test-type"])
        self.assertIn("name: test-type", res_show.stdout)

        # Verify that card-type path prints the path
        res_path = self.run_fleet(["card-type", "path", "test-type"])
        self.assertIn("test-type.md", res_path.stdout)

        # Remove the card type
        res_rm = self.run_fleet(["card-type", "rm", "test-type"])
        self.assertIn("removed", res_rm.stdout)
        self.assertFalse(manifest_path.exists())

    def test_given_card_type_validate_then_validates_and_previews(self):
        """Behavior: `fleet card-type validate` validates a build card type successfully."""
        res = self.run_fleet(["card-type", "validate", "build"])
        self.assertEqual(res.returncode, 0)
        self.assertIn("Card Type: build", res.stdout)
        self.assertIn("Phases:", res.stdout)
        self.assertIn("Composed Directive (default):", res.stdout)
        self.assertIn("Composed Directive (with --auto-review pr):", res.stdout)

if __name__ == "__main__":
    unittest.main()
