#!/usr/bin/env python3
"""fleet_help — Unified command-line interface helper for fleet CLI.

This module acts as the single source of truth for CLI commands, subcommands,
and options. It provides structured help documentation and validates input arguments.
"""
import argparse
import sys


def parse_args(args_list):
    """Parses and validates arguments from the CLI.
    
    If help is requested, it prints help and exits with 0.
    If a validation error occurs, it prints the error and exits non-zero.
    """
    parser = argparse.ArgumentParser(
        prog="fleet",
        description="fleet — control tower for parallel agent work"
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # 1. status / bare status
    p_status = subparsers.add_parser(
        "status",
        help="Show overview of parallel agent work (default)",
        description="Show overview of parallel agent work (default)"
    )
    p_status.add_argument("--root", action="append", help="Repo root to scan (repeatable)")
    p_status.add_argument("--json", action="store_true", help="Machine-readable output")
    p_status.add_argument("--no-agents", action="store_true", help="Skip live-agent detection")
    p_status.add_argument("--no-kanban", action="store_true", help="Skip kanban board source")
    p_status.add_argument("--no-linear", action="store_true", help="Skip Linear enrichment")
    p_status.add_argument("--all", action="store_true", help="Include Done/closed items")

    # 2. task
    p_task = subparsers.add_parser(
        "task",
        help="Manage cards/tasks on the board",
        description="Manage cards/tasks on the board"
    )
    task_subs = p_task.add_subparsers(dest="subcommand", help="Task subcommands")
    
    # task create / new / add
    p_task_create = task_subs.add_parser(
        "create",
        aliases=["new", "add"],
        help="Create a new task on the board",
        description="Create a new task on the board"
    )
    p_task_create.add_argument("--prompt", "-p", help="Prompt description text")
    p_task_create.add_argument("--prompt-file", help="Path to a file containing the prompt")
    p_task_create.add_argument("--file", help="Path to a markdown card file")
    p_task_create.add_argument("--markdown", help="Path to a markdown card file")
    p_task_create.add_argument("--title", "-t", help="Task title")
    p_task_create.add_argument("--repo", help="Target repository name (default: first in project)")
    p_task_create.add_argument("--agent", default="claude", help="Agent ID (default: claude)")
    p_task_create.add_argument("--model", help="Agent model name")
    p_task_create.add_argument("--issue", "--external-issue", dest="issue", help="Associated external issue identifier")
    p_task_create.add_argument("--base-ref", help="Base branch reference")
    p_task_create.add_argument("--type", help="Card type")
    p_task_create.add_argument("--auto-review", choices=["pr"], help="Auto-review mode")
    p_task_create.add_argument("--start", action="store_true", help="Start the task immediately")

    # task start
    p_task_start = task_subs.add_parser("start", help="Start a task", description="Start a task")
    p_task_start.add_argument("id", nargs="?", help="Task ID to start")

    # task ls / list
    task_subs.add_parser("ls", aliases=["list"], help="List tasks", description="List tasks")

    # task cat
    p_task_cat = task_subs.add_parser("cat", help="Show task details", description="Show task details")
    p_task_cat.add_argument("id", nargs="?", help="Task ID")

    # task tail
    p_task_tail = task_subs.add_parser("tail", help="Tail task logs", description="Tail task logs")
    p_task_tail.add_argument("id", nargs="?", help="Task ID")

    # task say
    p_task_say = task_subs.add_parser("say", help="Send a message to a task", description="Send a message to a task")
    p_task_say.add_argument("id", help="Task ID")
    p_task_say.add_argument("message", help="Message text")

    # task update
    p_task_update = task_subs.add_parser("update", help="Update task properties", description="Update task properties")
    p_task_update.add_argument("id", help="Task ID")

    # task link
    p_task_link = task_subs.add_parser("link", help="Link a branch to a task", description="Link a branch to a task")
    p_task_link.add_argument("id", help="Task ID")

    # task unlink
    p_task_unlink = task_subs.add_parser("unlink", help="Unlink a branch from a task", description="Unlink a branch from a task")
    p_task_unlink.add_argument("id", help="Task ID")

    # task done
    p_task_done = task_subs.add_parser("done", help="Mark a task as done", description="Mark a task as done")
    p_task_done.add_argument("id", nargs="?", help="Task ID")

    # task land
    p_task_land = task_subs.add_parser("land", help="Land a completed task", description="Land a completed task")
    p_task_land.add_argument("id", nargs="?", help="Task ID")

    # task delete / rm
    p_task_delete = task_subs.add_parser("delete", aliases=["rm"], help="Delete a task", description="Delete a task")
    p_task_delete.add_argument("id", nargs="?", help="Task ID")

    # 3. epic
    p_epic = subparsers.add_parser(
        "epic",
        help="Manage epic workspaces",
        description="Manage epic workspaces"
    )
    epic_subs = p_epic.add_subparsers(dest="subcommand", help="Epic subcommands")

    p_epic_create = epic_subs.add_parser("create", help="Create a new epic workspace", description="Create a new epic workspace")
    p_epic_create.add_argument("name", help="Name of the epic")
    p_epic_create.add_argument("--repo", help="Target repository name (default: first in project)")
    p_epic_create.add_argument("--base", default="production-line", help="Base branch (default: production-line)")

    p_epic_complete = epic_subs.add_parser("complete", help="Complete and clean up an epic workspace", description="Complete and clean up an epic workspace")
    p_epic_complete.add_argument("name", help="Name of the epic")
    p_epic_complete.add_argument("--repo", help="Target repository name (default: first in project)")

    p_epic_sync = epic_subs.add_parser("sync", help="Sync an epic workspace with its base branch", description="Sync an epic workspace with its base branch")
    p_epic_sync.add_argument("name", help="Name of the epic")
    p_epic_sync.add_argument("--repo", help="Target repository name (default: first in project)")

    # 4. xtools
    p_xtools = subparsers.add_parser(
        "xtools",
        aliases=["xtool", "x"],
        help="Manage agent-authored ad-hoc commands",
        description="Manage agent-authored ad-hoc commands"
    )
    xtools_subs = p_xtools.add_subparsers(dest="subcommand", help="Xtools subcommands")
    xtools_subs.add_parser("ls", help="List registered xtools", description="List registered xtools")
    p_xtools_new = xtools_subs.add_parser("new", help="Create a new xtool", description="Create a new xtool")
    p_xtools_new.add_argument("name", help="Name of the tool")
    p_xtools_new.add_argument("--py", action="store_true", help="Create Python template instead of bash")
    p_xtools_edit = xtools_subs.add_parser("edit", help="Edit an xtool", description="Edit an xtool")
    p_xtools_edit.add_argument("name", help="Name of the tool")
    p_xtools_rm = xtools_subs.add_parser("rm", help="Remove an xtool", description="Remove an xtool")
    p_xtools_rm.add_argument("name", help="Name of the tool")

    # 5. linear / mine / tasks
    p_linear = subparsers.add_parser(
        "linear",
        aliases=["mine", "tasks"],
        help="List your Linear issues",
        description="List your Linear issues"
    )
    p_linear.add_argument("--assigned", action="store_true", help="Only show issues assigned to you")
    p_linear.add_argument("--created", action="store_true", help="Only show issues you created")
    p_linear.add_argument("--all", action="store_true", help="Include Done/closed items")

    # 6. initiatives
    p_initiatives = subparsers.add_parser(
        "initiatives",
        aliases=["inits", "initiative"],
        help="List Linear initiatives",
        description="List Linear initiatives"
    )
    p_initiatives.add_argument("--issues", action="store_true", help="Drill down into issues under each project")
    p_initiatives.add_argument("--all", action="store_true", help="Include Planned/Completed initiatives")

    # 7. budget
    p_budget = subparsers.add_parser(
        "budget",
        aliases=["limits", "usage"],
        help="Agent session/window budget",
        description="Agent session/window budget"
    )
    p_budget.add_argument("--json", action="store_true", help="Machine-readable output")
    p_budget.add_argument("--no-claude", action="store_true", help="Exclude Claude usage")
    p_budget.add_argument("--no-codex", action="store_true", help="Exclude Codex usage")
    p_budget.add_argument("--no-cursor", action="store_true", help="Exclude Cursor usage")
    p_budget.add_argument("--cached", action="store_true", help="Use short-TTL cache")

    # 8. kanban
    p_kanban = subparsers.add_parser(
        "kanban",
        help="Manage fleet-managed kanban server",
        description="Manage fleet-managed kanban server"
    )
    kanban_subs = p_kanban.add_subparsers(dest="subcommand", help="Kanban subcommands")
    kanban_subs.add_parser("install", help="Install the kanban server binary", description="Install the kanban server binary")
    kanban_subs.add_parser("start", help="Start the kanban server", description="Start the kanban server")
    p_kstop = kanban_subs.add_parser("stop", help="Stop the kanban server", description="Stop the kanban server")
    p_kstop.add_argument("--force", "-f", action="store_true", help="Force stop even if run under service")
    kanban_subs.add_parser("restart", help="Restart the kanban server", description="Restart the kanban server")
    kanban_subs.add_parser("sync", help="Register/sync configured repos as projects", description="Register/sync configured repos as projects")
    kanban_subs.add_parser("open", help="Open the kanban board in browser", description="Open the kanban board in browser")
    kanban_subs.add_parser("status", help="Show kanban server status", description="Show kanban server status")

    # 9. service
    p_service = subparsers.add_parser(
        "service",
        aliases=["svc"],
        help="Run/manage the board under launchd",
        description="Run/manage the board under launchd"
    )
    service_subs = p_service.add_subparsers(dest="subcommand", help="Service subcommands")
    service_subs.add_parser("start", help="Install and start the board daemon", description="Install and start the board daemon")
    service_subs.add_parser("stop", help="Uninstall/stop the board daemon", description="Uninstall/stop the board daemon")
    p_srestart = service_subs.add_parser("restart", help="Restart the board daemon", description="Restart the board daemon")
    p_srestart.add_argument("--build", action="store_true", help="Rebuild source checkout first")
    p_srestart.add_argument("--install", action="store_true", help="Re-install npm dependencies and build")
    service_subs.add_parser("status", help="Show daemon status", description="Show daemon status")

    # 10. new
    p_new = subparsers.add_parser("new", help="Create a runnable worktree (shortcut for wt new)", description="Create a runnable worktree (shortcut for wt new)")
    p_new.add_argument("branch", help="Branch name")
    p_new.add_argument("base", nargs="?", help="Base branch/ref (default: origin/HEAD)")

    # 11. up
    p_up = subparsers.add_parser("up", help="Prepare/adopt a worktree (shortcut for wt up)", description="Prepare/adopt a worktree (shortcut for wt up)")
    p_up.add_argument("dir", nargs="?", help="Directory of worktree")

    # 12. run
    p_run = subparsers.add_parser("run", help="Start the app on this worktree's port (shortcut for wt run)", description="Start the app on this worktree's port (shortcut for wt run)")

    # 13. ls
    p_ls = subparsers.add_parser("ls", help="List worktrees and their ports (shortcut for wt ls)", description="List worktrees and their ports (shortcut for wt ls)")

    # 14. rm
    p_rm = subparsers.add_parser("rm", help="Remove a worktree and free its port (shortcut for wt rm)", description="Remove a worktree and free its port (shortcut for wt rm)")
    p_rm.add_argument("dir", nargs="?", help="Directory of worktree")

    # 15. port
    p_port = subparsers.add_parser("port", help="Stable per-worktree port mapping", description="Stable per-worktree port mapping")
    p_port.add_argument("--path", help="Path to get/set port for")
    p_port.add_argument("--base", type=int, help="Base port number")
    p_port.add_argument("--range", type=int, help="Port range size")
    p_port.add_argument("--list", action="store_true", help="List all port allocations")
    p_port.add_argument("--release", nargs="?", help="Release allocated port for path")

    # 16. init
    p_init = subparsers.add_parser("init", help="Guided setup: project config, repos, Linear key, kanban", description="Guided setup: project config, repos, Linear key, kanban")
    p_init.add_argument("--name", help="Project name")
    p_init.add_argument("--dir", "--root", dest="dir", help="Project root directory")
    p_init.add_argument("--linear-team", help="Linear team prefix (default: ENG)")
    p_init.add_argument("--linear-key", help="Linear API key")
    p_init.add_argument("--port", type=int, help="Kanban board port (default: 3484)")
    p_init.add_argument("--force", action="store_true", help="Overwrite existing configuration")
    p_init.add_argument("--yes", "-y", action="store_true", help="Non-interactive/yes confirmation")

    # 17. update
    p_update = subparsers.add_parser("update", help="Refresh the shared fleet-kanban build", description="Refresh the shared fleet-kanban build")
    p_update.add_argument("--repo", help="Git repository URL to clone/fetch")
    p_update.add_argument("--ref", "--branch", dest="ref", help="Branch/ref to check out (default: main)")
    p_update.add_argument("--check", action="store_true", help="Check if an update is available without applying it")
    p_update.add_argument("--json", action="store_true", help="With --check: output status as JSON")

    # 18. card-type
    p_ct = subparsers.add_parser(
        "card-type",
        aliases=["card-types", "ct"],
        help="Manage card types",
        description="Manage card types"
    )
    ct_subs = p_ct.add_subparsers(dest="subcommand", help="Card-type subcommands")
    ct_subs.add_parser("ls", aliases=["list"], help="List registered card types", description="List registered card types")
    p_ct_new = ct_subs.add_parser("new", aliases=["create"], help="Create a new card type", description="Create a new card type")
    p_ct_new.add_argument("name", help="Name of the card type")
    p_ct_path = ct_subs.add_parser("path", aliases=["which"], help="Show path of a card type", description="Show path of a card type")
    p_ct_path.add_argument("name", help="Name of the card type")
    p_ct_show = ct_subs.add_parser("show", aliases=["cat"], help="Display card type definition", description="Display card type definition")
    p_ct_show.add_argument("name", help="Name of the card type")
    p_ct_edit = ct_subs.add_parser("edit", help="Edit a card type", description="Edit a card type")
    p_ct_edit.add_argument("name", help="Name of the card type")
    p_ct_rm = ct_subs.add_parser("rm", aliases=["remove", "delete"], help="Remove a card type", description="Remove a card type")
    p_ct_rm.add_argument("name", help="Name of the card type")
    p_ct_val = ct_subs.add_parser("validate", help="Validate card type definition", description="Validate card type definition")
    p_ct_val.add_argument("name", help="Name of the card type")

    # 19. agent
    p_agent = subparsers.add_parser(
        "agent",
        help="Manage automated agent sessions",
        description="Manage automated agent sessions"
    )
    agent_subs = p_agent.add_subparsers(dest="subcommand", help="Agent subcommands")
    
    p_agent_plan = agent_subs.add_parser("plan", aliases=["start"], help="Start an agent plan session", description="Start an agent plan session")
    p_agent_plan.add_argument("id", metavar="ENG-ID", help="Linear issue identifier")
    p_agent_plan.add_argument("--repo", help="Target repository name")
    p_agent_plan.add_argument("--agent", default="claude", choices=["claude", "codex", "gemini"], help="Agent ID")
    p_agent_plan.add_argument("--no-start", action="store_true", help="Create card but do not start agent")

    p_agent_imp = agent_subs.add_parser("implement", help="Start an agent implementation session", description="Start an agent implementation session")
    p_agent_imp.add_argument("id", metavar="ENG-ID", help="Linear issue identifier")
    p_agent_imp.add_argument("--repo", help="Target repository name")
    p_agent_imp.add_argument("--agent", default="claude", choices=["claude", "codex", "gemini"], help="Agent ID")
    p_agent_imp.add_argument("--no-start", action="store_true", help="Create card but do not start agent")

    # We use parse_known_args to allow unrecognized extra arguments
    # (e.g. task create forwards extra flags directly to kanban)
    parsed, extra = parser.parse_known_args(args_list)
    return parsed, extra


if __name__ == "__main__":
    parse_args(sys.argv[1:])
