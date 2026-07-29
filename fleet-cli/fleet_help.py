#!/usr/bin/env python3
"""fleet_help — Unified command-line interface helper for fleet CLI.

This module acts as a dynamic delegation helper for CLI help, avoiding duplicate
command/flag declarations and preventing any possibility of description drift.
"""
import os
import sys
import subprocess
from pathlib import Path


def find_kanban_bin():
    """Resolves the kanban binary path from configuration and environment."""
    kanban_source = os.environ.get("KANBAN_SOURCE")
    if kanban_source and os.path.exists(os.path.join(kanban_source, "dist/cli.js")):
        return os.path.join(kanban_source, "dist/cli.js")
    
    home = Path.home()
    global_dir = home / ".config" / "fleet"
    src_vendor = global_dir / "src" / "dist" / "cli.js"
    if src_vendor.exists():
        return str(src_vendor)
        
    fleet_repo = Path(__file__).parent.parent
    local_cli = fleet_repo / "dist" / "cli.js"
    if local_cli.exists():
        return str(local_cli)
        
    vendor_cli = global_dir / "vendor" / "node_modules" / ".bin" / "kanban"
    if vendor_cli.exists():
        return str(vendor_cli)
        
    return "kanban"


def run_command(cmd_args, env=None):
    """Executes a subprocess command to display help and exits with its return code."""
    r = subprocess.run(cmd_args, capture_output=True, text=True, env=env)
    if r.returncode == 0:
        print(r.stdout.strip())
        sys.exit(0)
    else:
        print(r.stderr.strip(), file=sys.stderr)
        sys.exit(r.returncode)


def parse_args(args_list):
    """Parses arguments and dynamically delegates help printing to target parsers."""
    is_help = any(arg in ("--help", "-h") for arg in args_list)
    if not is_help:
        # If no help is requested, we do nothing and let the main CLI execute.
        return None, []

    clean_args = [arg for arg in args_list if arg not in ("--help", "-h")]

    cli_dir = Path(__file__).parent
    fleet_py = cli_dir / "fleet.py"
    budget_py = cli_dir / "budget.py"
    port_for = cli_dir / "port-for"

    if not clean_args:
        # Bare fleet help: read top comments from the fleet bash wrapper script
        fleet_sh = cli_dir / "fleet"
        if fleet_sh.exists():
            comments = []
            for line in fleet_sh.read_text().splitlines():
                if line.startswith("#!"):
                    continue
                if line.startswith("#"):
                    comments.append(line[1:].lstrip())
                else:
                    break
            print("usage: fleet <command> [options]\n")
            print("\n".join(comments))
            sys.exit(0)
        else:
            print("fleet — control tower for parallel agent work", file=sys.stderr)
            sys.exit(0)

    cmd = clean_args[0]
    subcmd = clean_args[1] if len(clean_args) > 1 else None

    if cmd in ("status",):
        run_command([sys.executable, str(fleet_py), "--help"])

    elif cmd in ("budget", "limits", "usage"):
        run_command([sys.executable, str(budget_py), "--help"])

    elif cmd in ("port",):
        run_command([sys.executable, str(port_for), "--help"])

    elif cmd in ("epic",):
        # Translate to fleet.py epic
        run_args = [sys.executable, str(fleet_py), "epic"]
        if subcmd:
            run_args.extend([subcmd, "--help"])
        else:
            run_args.append("--help")
        run_command(run_args)

    elif cmd in ("linear", "mine", "tasks"):
        run_command([sys.executable, str(fleet_py), "--mine", "--help"])

    elif cmd in ("initiatives", "inits", "initiative"):
        run_command([sys.executable, str(fleet_py), "--initiatives", "--help"])

    elif cmd in ("agent",):
        if subcmd in ("plan", "start"):
            run_command([sys.executable, str(fleet_py), "--agent-plan", "--help"])
        elif subcmd == "implement":
            run_command([sys.executable, str(fleet_py), "--agent-implement", "--help"])
        else:
            print("usage: fleet agent plan|implement <ENG-ID> [--repo NAME] [--agent claude|codex] [--no-start]")
            sys.exit(0)

    elif cmd in ("task",):
        fleet_sh = Path(__file__).parent / "fleet"
        env = os.environ.copy()
        env["FLEET_HELP_INTERNAL"] = "1"
        run_command(["bash", str(fleet_sh), "task", subcmd if subcmd else "--help", "--help"], env=env)

    elif cmd in ("card-type", "card-types", "ct"):
        kanban = find_kanban_bin()
        node_exec = "node"
        if subcmd:
            if subcmd in ("list",):
                subcmd = "list"
            elif subcmd in ("create",):
                subcmd = "new"
            elif subcmd in ("which",):
                subcmd = "path"
            elif subcmd in ("cat",):
                subcmd = "show"
            elif subcmd in ("remove", "delete"):
                subcmd = "rm"
            run_command([node_exec, kanban, "card-type", subcmd, "--help"])
        else:
            run_command([node_exec, kanban, "card-type", "--help"])

    elif cmd in ("service", "svc"):
        print("usage: fleet service [start|stop|restart [--build|--install]|status]\n")
        print("Run/manage the board under launchd.")
        sys.exit(0)

    elif cmd in ("kanban",):
        print("usage: fleet kanban [install|start|stop|restart|daemon|sync|open|status]\n")
        print("Manage fleet-managed kanban server.")
        sys.exit(0)

    elif cmd in ("xtools", "xtool", "x"):
        print("usage: fleet xtools [ls | new <name> [--py] | edit <name> | rm <name>]\n")
        print("Manage agent-authored ad-hoc commands.")
        sys.exit(0)

    elif cmd in ("new", "up", "run", "ls", "rm"):
        print("Manage git worktrees with stable ports and linked configurations.\n")
        print("Usage:")
        print("  fleet new  <branch> [base]  Create off base (default origin/HEAD) and prepare worktree")
        print("  fleet up   [dir]           Prepare/adopt an existing worktree")
        print("  fleet run  [-- args]       Start the app on this worktree's port")
        print("  fleet ls                  List worktrees, ports, and listening states")
        print("  fleet rm   [dir]           Remove worktree and free its port")
        sys.exit(0)

    elif cmd in ("port",):
        run_command([sys.executable, str(port_for), "--help"])

    elif cmd in ("init",):
        print("usage: fleet init [--name NAME] [--dir|--root ROOT] [--linear-team TEAM]")
        print("                  [--linear-key KEY] [--port PORT] [--force] [--yes|-y]\n")
        print("Guided setup: project config, repos, Linear key, kanban.")
        sys.exit(0)

    elif cmd in ("update",):
        print("usage: fleet update [--repo <git-url>] [--ref <branch>] [--check [--json]]\n")
        print("Refresh the shared fleet-kanban build, or check whether one is available.")
        sys.exit(0)

    else:
        # Fallback to status help
        run_command([sys.executable, str(fleet_py), "--help"])


if __name__ == "__main__":
    parse_args(sys.argv[1:])
