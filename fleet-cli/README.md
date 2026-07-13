# fleet — control tower for parallel agent work

Four small tools + one config dir. They make many parallel branches/agents
**visible**, **runnable**, and **grouped by Linear epic** — without cloning a repo 5×.

```
fleet       overview: every worktree + kanban card, grouped by ENG-#### epic
wt          make a git worktree actually runnable (deps + config + port)
port-for    a stable, unique port per worktree
fleet init  guided setup (project config, repos, Linear key, kanban)
```

Installed as symlinks in `~/.local/bin`. Config is **project-bound**: a `.fleet/` folder in the
project root (found by walking up from CWD, like `.git`) holds config + ports + cache + logs.
Create one with `fleet init` inside your project dir.

```
~/code/myproject/          ← project root
  .fleet/                  ← config.json (name, repos, linear_team, kanban_port), ports.json,
                             linear.key, linear-cache.json, kanban.log   (git-ignored)
  webapp/  api/  ...        ← the repos, auto-detected by `fleet init`
  _work/
```
The kanban binary itself is shared (`~/.config/fleet/vendor`); everything else is per-project.

---

## Mental model

| Layer | Tool | What it does |
|---|---|---|
| **See** | `fleet` | Reads all git worktrees + kanban boards, parses `ENG-####` from branch/title, groups by epic, shows agent + port + git state. Read-only. |
| **Run** | `wt` / `port-for` | Turns a bare worktree into a running app on its own port. Fixes the two reasons worktrees "don't work": missing gitignored files + port clashes. |
| **Setup** | `fleet init` | Registers a project (a set of repos), stores the Linear key, points you at kanban. |

`fleet` never changes anything. `wt` only touches worktrees. Kanban still owns
its own worktrees/agents (in `~/.cline/worktrees`) — `fleet` just *reads* them too.

---

## Daily use

**See everything, grouped by epic:**
```bash
fleet                       # the project you're in (resolved via .fleet)
fleet --root PATH           # ad-hoc: scan a specific dir instead
fleet --no-agents           # faster (skip live-agent detection)
fleet --json                # machine-readable
```
Row legend: `●`=live agent · `:3102`=assigned port (`:3102▶`=listening) ·
`1✗`=uncommitted files · `+5/-164`=commits ahead/behind base · age.
Items whose Linear issue is **Done/closed are hidden by default** (`--all` to show them);
the header notes how many were hidden.

**Spin up a branch to work on, on its own port:**
```bash
cd ~/code/myproject/webapp
fleet new eng-1799              # git worktree in <project>/_work/webapp.eng-1799 + link .env* + pnpm install + assign port
cd ../_work/webapp.eng-1799
fleet run                      # PORT=<assigned> pnpm --filter @acme/web dev
```

**Adopt an existing worktree that won't start** (missing node_modules/.env):
```bash
cd <some-worktree>
fleet up                       # symlink gitignored config from main + install + port
```

**See your Linear queue** (assigned to or created by you, open issues), and which you've already started locally:
```bash
fleet linear                # both assigned + created
fleet linear --assigned     # only assigned to you
fleet linear --created      # only created by you
```
Grouped by Initiative / Project; a `●`/`local wt` marks issues that already have a worktree. Needs the Linear key.

**Top-down "who's working where"** (Linear hierarchy: Initiative › Project › Issue › Sub-issue):
```bash
fleet initiatives           # Active initiatives → projects, sorted by #in-progress, with assignees
fleet initiatives --issues  # also drill down into the issues under each project
fleet initiatives --all     # include Planned/Completed initiatives + closed projects
```
Default shows just initiatives + projects (no issues), each with its in-progress count and the
people working on it. Sorted by in-progress volume so the busiest work floats to the top;
`●`/`local` marks initiatives you have a worktree under.

**Housekeeping:**
```bash
fleet ls                       # worktrees + ports + which are listening
fleet port                     # the port for $PWD
fleet rm <dir>                 # remove worktree + free its port (keeps the branch)
```

---

## Linear (optional but recommended)

Group headers show the Linear **issue title · Initiative / Project · [status]** once
a key is present. Get a key at **Linear → Settings → Security & access → Personal API keys**:

```bash
fleet linear api-key lin_api_xxx        # easiest — stores (chmod 600) + validates live
fleet init --name myproject --linear-key lin_api_xxx --yes   # or during setup
# or:  export LINEAR_API_KEY=lin_api_xxx
```
Stored in the project's `.fleet/linear.key` (or `~/.config/fleet/linear.key` as a shared fallback).
Cached 6h in `.fleet/linear-cache.json`. Team key comes from `.fleet/config.json` (`linear_team`).

---

## Kanban relationship

`fleet` reads your kanban board too (`~/.cline/kanban/workspaces/*`), so kanban
cards and manual worktrees appear in one epic-grouped view. Kanban remains the
place to *start* managed agent sessions (live status, diff review, commit/PR).
`fleet kanban` checks it's running; `fleet kanban open` opens the board.

---

## Config

- `<project>/.fleet/config.json` — name, repos (auto-detected), linear_team, kanban_port
- `<project>/.fleet/ports.json` — worktree path → port registry
- `<project>/.fleet/linear.key` — Linear API key (chmod 600), or `~/.config/fleet/linear.key` shared
- `<project>/.fleet/kanban.log` — kanban server log
- `~/.config/fleet/vendor/` — the shared kanban binary (`fleet kanban install`)
- `<repo>/.fleet.env` — optional per-repo override of `LINK_GLOBS` / `RUN_CMD`
