#!/usr/bin/env python3
"""
fleet — one screen for parallel agent work, grouped by Linear epic (ENG-####).

Unifies two sources of truth:
  1. git worktrees across your repos  (where work actually happens today)
  2. Cline Kanban board + live sessions (~/.cline/kanban)

Groups everything by the ENG-#### reference parsed from the branch name or the
kanban card title, so you see: EPIC -> repo/branch -> agent -> live status.

Start-simple today (ENG ids only). The `epic_meta()` seam is where Linear
Project/Initiative enrichment plugs in later without touching the rest.

Usage:
    fleet.py                 # scan configured repo roots (default ~/code/repos)
    fleet.py --root PATH     # override scan root (repeatable)
    fleet.py --project NAME  # use a named repo-set from the config file
    fleet.py --json          # machine-readable output
    fleet.py --no-agents     # skip live-agent detection (faster)

Config (optional): ~/.config/fleet/projects.json
    { "projects": { "myproject": { "roots": ["~/code/repos/myproject",
                                             "~/code/repos/myproject-2"] } },
      "default_root": "~/code/repos" }
"""
from __future__ import annotations
import argparse, json, os, re, socket, subprocess, sys, time
from pathlib import Path

HOME = Path.home()
KANBAN_HOME = HOME / ".cline" / "kanban"
KANBAN_WORKTREES = HOME / ".cline" / "worktrees"
GLOBAL_DIR = HOME / ".config" / "fleet"        # shared: vendored kanban binary, key fallback

def find_fleet_dir(start=None):
    """The project's `.fleet/` dir, found by walking up from `start` (like .git)."""
    env = os.environ.get("FLEET_DIR")
    if env:
        return Path(env)
    p = Path(start or os.getcwd()).resolve()
    for d in [p, *p.parents]:
        if (d / ".fleet").is_dir():
            return d / ".fleet"
    return None

FLEET_DIR = find_fleet_dir()
PROJECT_DIR = FLEET_DIR.parent if FLEET_DIR else None
_BASE = FLEET_DIR or GLOBAL_DIR                 # where this run reads/writes config + tmp
CONFIG = _BASE / "config.json"
PORTS_REG = _BASE / "ports.json"
ENG_RE = re.compile(r"(?i)\beng[-_ ]?(\d+)")

# ---- ANSI ----
def _c(code): return "" if not sys.stdout.isatty() else code
DIM, BOLD, RESET = _c("\033[2m"), _c("\033[1m"), _c("\033[0m")
GREEN, YELLOW, RED = _c("\033[32m"), _c("\033[33m"), _c("\033[31m")
BLUE, CYAN, MAG = _c("\033[34m"), _c("\033[36m"), _c("\033[35m")


def sh(args, cwd=None):
    try:
        return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=15).stdout.strip()
    except Exception:
        return ""


def epic_of(*texts) -> str | None:
    for t in texts:
        if not t:
            continue
        m = ENG_RE.search(t)
        if m:
            return f"ENG-{m.group(1)}"
    return None


# ---- Linear enrichment --------------------------------------------------------
# Resolves an ENG-#### reference to {title, project, initiative, status} via the
# Linear GraphQL API. Needs LINEAR_API_KEY (Settings > Security & access >
# Personal API keys). Results are cached on disk so we don't re-query each run.
import urllib.request

LINEAR_URL = "https://api.linear.app/graphql"
LINEAR_CACHE = _BASE / "linear-cache.json"
CACHE_TTL = 6 * 3600
_epic_cache: dict[str, dict] = {}

_LINEAR_Q = """
query($numbers:[Float!]!, $team:String!) {
  issues(first:250, filter:{ number:{ in:$numbers }, team:{ key:{ eq:$team } } }) {
    nodes {
      identifier title
      state { name }
      project { name initiatives(first:2) { nodes { name } } }
    }
  }
}"""

def _load_disk_cache() -> dict:
    data = _read_json(LINEAR_CACHE) or {}
    now = time.time()
    return {k: v for k, v in data.items()
            if isinstance(v, dict) and now - v.get("_fetched", 0) < CACHE_TTL}

LINEAR_KEYFILE = _BASE / "linear.key"

def _linear_key():
    k = os.environ.get("LINEAR_API_KEY")
    if k:
        return k.strip()
    for f in (LINEAR_KEYFILE, GLOBAL_DIR / "linear.key"):   # project key, then shared fallback
        try:
            return f.read_text().strip()
        except Exception:
            continue
    return None

def _linear_call(numbers: list[int], team: str) -> dict:
    key = _linear_key()
    if not key:
        return {}
    body = json.dumps({"query": _LINEAR_Q, "variables": {"numbers": numbers, "team": team}}).encode()
    req = urllib.request.Request(LINEAR_URL, data=body, method="POST",
                                 headers={"Authorization": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            payload = json.loads(r.read())
    except Exception as e:
        print(f"{DIM}(linear: {e}){RESET}", file=sys.stderr)
        return {}
    out = {}
    for n in (payload.get("data", {}).get("issues", {}) or {}).get("nodes", []):
        proj = n.get("project") or {}
        inits = [i["name"] for i in ((proj.get("initiatives") or {}).get("nodes") or [])]
        out[n["identifier"]] = {
            "title": n.get("title"),
            "project": proj.get("name"),
            "initiative": inits[0] if inits else None,
            "status": (n.get("state") or {}).get("name"),
            "_fetched": time.time(),
        }
    return out

def prefetch_epics(eng_ids: set[str], team: str = None):
    """Populate the epic cache for all referenced ENG ids in one API call."""
    team = team or os.environ.get("LINEAR_TEAM_KEY", "ENG")
    _epic_cache.update(_load_disk_cache())
    missing = [e for e in eng_ids if e and e not in _epic_cache]
    numbers = []
    for e in missing:
        m = re.match(r"[A-Z]+-(\d+)", e)
        if m:
            numbers.append(int(m.group(1)))
    if not numbers:
        return
    fetched = _linear_call(numbers, team)
    _epic_cache.update(fetched)
    # persist merged cache
    try:
        LINEAR_CACHE.parent.mkdir(parents=True, exist_ok=True)
        LINEAR_CACHE.write_text(json.dumps(_epic_cache, indent=2))
    except Exception:
        pass

def epic_meta(eng_id: str) -> dict:
    return _epic_cache.get(eng_id, {"title": None, "project": None, "initiative": None, "status": None})


# ---- agent start: Linear issue -> kanban card (validate + design) -------------
_ISSUE_Q = """
query($n:Float!, $t:String!) {
  issues(filter:{ number:{ eq:$n }, team:{ key:{ eq:$t } } }) {
    nodes { identifier title url description
            state{ name } project{ name initiatives(first:2){ nodes{ name } } } } }
}"""

def fetch_issue(eng_id: str, team: str):
    m = re.match(r"[A-Za-z]+-(\d+)", eng_id)
    if not m:
        return None
    data = linear_graphql(_ISSUE_Q, {"n": int(m.group(1)), "t": team})
    nodes = (((data or {}).get("data") or {}).get("issues") or {}).get("nodes") or []
    return nodes[0] if nodes else None

def _handover_prompt(issue: dict) -> str:
    return f"""You are validating and scoping a Linear issue BEFORE any implementation.

# Linear {issue['identifier']}: {issue.get('title','')}
{issue.get('url','')}
Current Linear status: {(issue.get('state') or {}).get('name','?')}

## Issue description (verbatim from Linear)
{issue.get('description') or '(no description provided)'}

# YOUR TASK — analysis only, do NOT implement
1. Research the CURRENT codebase and decide whether this issue is still VALID:
   already done, partially done, superseded, or still needed. Cite specific files/lines as evidence.
2. If INVALID or already-done: state that clearly with evidence, and stop.
3. If VALID, produce ONE of:
   - trivial/mechanical change -> concise numbered IMPLEMENTATION INSTRUCTIONS (exact files,
     functions, and edits) a developer/agent can follow directly.
   - larger change -> a DESIGN DOCUMENT: problem, chosen approach, files to touch, risks, test plan.
4. Restate the issue's acceptance criteria and map your plan to each item.
5. Write your output to `docs/design/{issue['identifier']}.md` (create the directory if needed),
   and summarize your VERDICT (valid / invalid / needs-discussion) in your final message.

# Hard constraints
- Do NOT modify source code or tests. The ONLY file you create is that one markdown doc.
- Ground every claim in code you actually read — no speculation.
"""

def _implement_prompt(issue: dict, design: str) -> str:
    eid = issue['identifier']
    design_block = (f"## Approved design — implement this precisely\n\n{design}\n" if design
                    else "No prior design doc was found — do a brief validation + design first, then implement.")
    return f"""You are implementing a Linear issue end-to-end in THIS worktree.

# Linear {eid}: {issue.get('title','')}
{issue.get('url','')}

## Issue (from Linear)
{issue.get('description') or '(no description)'}

{design_block}

# YOUR TASK
1. Implement the change here, following the approved design and the repo house rules
   (CLAUDE.md / AGENTS.md): TDD, license headers, reuse existing building blocks.
2. Ensure `docs/design/{eid}.md` exists in the repo (write it from the approved design above
   if it isn't already present) so the design ships in the same PR as the code.
3. When the build is green, ship it end-to-end with the repo's ship command:  `/ship {eid}`
   — it reviews the diff, opens the PR, babysits CI, and squash-merges (marking {eid} Done).
   It honors CLAUDE_MODE gates; any pause points surface in this card for your approval.
4. Do NOT re-scope or re-design — the design is settled.
"""

def _kanban_bin(cfg=None):
    # Prefer this project's source build (dogfood) when configured, like the shell `kanban_bin`.
    src = (cfg or {}).get("kanban_source")
    if src:
        dist = Path(src).expanduser() / "dist" / "cli.js"
        if dist.exists():
            return str(dist)
    p = GLOBAL_DIR / "vendor" / "node_modules" / ".bin" / "kanban"
    if p.exists():
        return str(p)
    import shutil
    return shutil.which("kanban")


def _kanban_env(cfg=None):
    """Environment for kanban task subcommands. Without these the CLI targets ~/.cline and the
    default runtime port 3484: CLINE_HOME isolates board/worktree state to this project's
    `.fleet/cline`, and KANBAN_RUNTIME_PORT points the CLI at this project's running board —
    mirroring the `fleet kanban` shell wiring."""
    env = dict(os.environ)
    if FLEET_DIR and FLEET_DIR != GLOBAL_DIR:
        env["CLINE_HOME"] = str(FLEET_DIR / "cline")
    env["KANBAN_RUNTIME_PORT"] = str((cfg or {}).get("kanban_port", 3484))
    return env

def _dig_id(obj):
    if isinstance(obj, dict):
        for k in ("taskId", "id"):
            if isinstance(obj.get(k), str):
                return obj[k]
        for v in obj.values():
            r = _dig_id(v)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _dig_id(v)
            if r:
                return r
    return None

def _resolve_repo(repo: str, cfg: dict):
    if not PROJECT_DIR:
        print(f"{RED}not inside a .fleet project (run from your project dir){RESET}", file=sys.stderr); return None
    repos = cfg.get("repos") or []
    repo = repo or (repos[0] if repos else None)
    if not repo:
        print(f"{RED}no repo — pass --repo <name>{RESET}", file=sys.stderr); return None
    rp = PROJECT_DIR / repo
    if not (rp / ".git").exists():
        print(f"{RED}{rp} is not a git repo{RESET}", file=sys.stderr); return None
    return rp

def _create_and_start(repo_path, title, prompt, agent, start, cfg, label):
    kb = _kanban_bin(cfg)
    if not kb:
        print(f"{RED}kanban binary not found — run: fleet kanban install{RESET}", file=sys.stderr); return 1
    env = _kanban_env(cfg)
    base = sh(["git", "-C", str(repo_path), "rev-parse", "--abbrev-ref", "origin/HEAD"]).removeprefix("origin/") or "main"
    print(f"{DIM}  {label} · repo {repo_path.name} · base {base} · agent {agent}{RESET}")
    create = subprocess.run([kb, "task", "create", "--project-path", str(repo_path), "--base-ref", base,
                             "--title", title, "--prompt", prompt, "--agent-id", agent],
                            capture_output=True, text=True, env=env)
    out = (create.stdout or "") + "\n" + (create.stderr or "")
    tid, m = None, re.search(r"\{.*\}", out, re.S)   # kanban prints pretty (multi-line) JSON
    if m:
        try:
            tid = _dig_id(json.loads(m.group(0)))
        except Exception:
            pass
    if not tid:
        print(f"{RED}task create failed:{RESET}\n{out[:400]}", file=sys.stderr); return 1
    print(f"{GREEN}✓ card created{RESET} {DIM}(task {tid}){RESET}")
    if start:
        s = subprocess.run([kb, "task", "start", "--task-id", tid, "--project-path", str(repo_path)],
                           capture_output=True, text=True, env=env)
        so = (s.stdout or "") + (s.stderr or "")
        if '"ok":false' in so or s.returncode != 0:
            print(f"{YELLOW}started with warning:{RESET} {so[:300]}")
        else:
            print(f"{GREEN}✓ started{RESET} {DIM}— worktree + {agent} agent{RESET}")
    print(f"{DIM}  watch: http://127.0.0.1:{cfg.get('kanban_port', 3484)}{RESET}")
    return 0

def _find_design_doc(repo_path, eng_id):
    """The design doc for eng_id, from the most-recent plan worktree (may be uncommitted),
    else committed on origin/main. Returns text or None."""
    rel = f"docs/design/{eng_id}.md"
    cands = list(KANBAN_WORKTREES.glob(f"*/{repo_path.name}/{rel}")) if KANBAN_WORKTREES.exists() else []
    cands.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for c in cands:
        try:
            return c.read_text()
        except Exception:
            continue
    return sh(["git", "-C", str(repo_path), "show", f"origin/main:{rel}"]) or None

def agent_plan(eng_id: str, repo: str, agent: str, cfg: dict, start: bool = True):
    rp = _resolve_repo(repo, cfg)
    if not rp:
        return 1
    issue = fetch_issue(eng_id.upper(), cfg.get("linear_team", "ENG"))
    if not issue:
        print(f"{RED}could not fetch {eng_id} from Linear{RESET}", file=sys.stderr); return 1
    print(f"{BOLD}{MAG}{issue['identifier']}{RESET} {issue.get('title','')}")
    title = f"[{issue['identifier']}] {issue.get('title','')}"[:118]
    return _create_and_start(rp, title, _handover_prompt(issue), agent, start, cfg, "plan")

def agent_implement(eng_id: str, repo: str, agent: str, cfg: dict, start: bool = True):
    rp = _resolve_repo(repo, cfg)
    if not rp:
        return 1
    eid = eng_id.upper()
    issue = fetch_issue(eid, cfg.get("linear_team", "ENG"))
    if not issue:
        print(f"{RED}could not fetch {eng_id} from Linear{RESET}", file=sys.stderr); return 1
    design = _find_design_doc(rp, eid)
    print(f"{BOLD}{MAG}{eid}{RESET} {issue.get('title','')}")
    print(f"{DIM}  design doc: {'found — embedding' if design else 'none — will design inline'}{RESET}")
    title = f"[{eid}] implement · {issue.get('title','')}"[:118]
    return _create_and_start(rp, title, _implement_prompt(issue, design), agent, start, cfg, "implement")


_INITIATIVES_Q = """
query { initiatives(first:100) {
  nodes { name status
    projects(first:25) { nodes { id name state } } } } }"""

def _fetch_project_issues(ids: list, include_done: bool) -> dict:
    """pid -> [ {identifier,title,inprog(bool),who} ]  for its non-done issues.
    Chunked to stay under Linear's query-complexity limit."""
    if not ids:
        return {}
    flt = "" if include_done else ', filter:{ state:{ type:{ nin:["completed","canceled"] } } }'
    q = ("query($ids:[ID!]!){ projects(first:25, filter:{ id:{ in:$ids } }) { nodes { id "
         "issues(first:40%FLT%){ nodes { identifier title state{ type } assignee{ displayName } } } } } }"
         ).replace("%FLT%", flt)
    out = {}
    for i in range(0, len(ids), 25):
        data = linear_graphql(q, {"ids": ids[i:i + 25]})
        for p in (((data or {}).get("data") or {}).get("projects") or {}).get("nodes") or []:
            out[p["id"]] = [{
                "identifier": n.get("identifier", ""), "title": n.get("title", ""),
                "inprog": (n.get("state") or {}).get("type") == "started",
                "who": (n.get("assignee") or {}).get("displayName"),
            } for n in (p.get("issues") or {}).get("nodes") or []]
    return out

def _who(rows):
    return sorted({r["who"] for r in rows if r["inprog"] and r["who"]})

def _fmt_who(people):
    if not people:
        return ""
    shown = people[:5]
    extra = f" +{len(people)-5}" if len(people) > 5 else ""
    return f"  {DIM}·{RESET} {BLUE}{', '.join(shown)}{extra}{RESET}"

def show_initiatives(repos, include_all: bool = False, show_issues: bool = False):
    data = linear_graphql(_INITIATIVES_Q)
    if not data:
        return
    inits = ((data.get("data") or {}).get("initiatives") or {}).get("nodes") or []
    le = local_epics(repos)
    if le:
        prefetch_epics(le)
    local_inits = {epic_meta(e).get("initiative") for e in le}
    local_inits.discard(None)

    order = {"Active": 0, "Planned": 1, "Completed": 2}
    shown = [i for i in inits if include_all or i.get("status") == "Active"]

    disp_projects = []
    for i in shown:
        for p in (i.get("projects") or {}).get("nodes") or []:
            if include_all or not is_closed(p.get("state")):
                disp_projects.append(p)
    issues_by_pid = _fetch_project_issues([p["id"] for p in disp_projects], include_all)

    # attach per-project in-progress count + people; roll up to initiative
    for i in shown:
        projs = [p for p in (i.get("projects") or {}).get("nodes") or []
                 if include_all or not is_closed(p.get("state"))]
        for p in projs:
            rows = issues_by_pid.get(p["id"], [])
            p["_ip"] = sum(1 for r in rows if r["inprog"])
            p["_who"] = _who(rows)
        projs.sort(key=lambda p: (-p["_ip"], p.get("name", "")))
        i["_projs"] = projs
        i["_ip"] = sum(p["_ip"] for p in projs)
        i["_who"] = sorted({w for p in projs for w in p["_who"]})

    # sort initiatives by in-progress count (then active-first, then name)
    shown.sort(key=lambda i: (-i["_ip"], order.get(i.get("status"), 9), i.get("name", "")))

    scope = "all statuses" if include_all else "active"
    print(f"\n{BOLD}INITIATIVES{RESET}  {DIM}· {scope} · by in-progress · {len(shown)} shown · "
          f"{GREEN}{sum(1 for i in shown if i.get('name') in local_inits)} with local work{RESET}\n")
    TAB = "    "
    for i in shown:
        name, st = i.get("name", "?"), i.get("status", "")
        stc = GREEN if st == "Active" else (DIM if st == "Completed" else YELLOW)
        loc = f"  {GREEN}● local{RESET}" if name in local_inits else ""
        ip = f"  {GREEN}{i['_ip']} in progress{RESET}" if i["_ip"] else f"  {DIM}0 in progress{RESET}"
        print(f"{BOLD}{MAG}{name}{RESET}  {stc}[{st}]{RESET}{ip}{_fmt_who(i['_who'])}{loc}")
        for p in i["_projs"]:
            ipc = f"{GREEN}{p['_ip']}{RESET}" if p["_ip"] else f"{DIM}0{RESET}"
            print(f"{TAB}{BOLD}{p.get('name','')}{RESET}  {DIM}[{p.get('state','')}] · {RESET}{ipc} "
                  f"{DIM}in progress{RESET}{_fmt_who(p['_who'])}")
            if show_issues:
                for r in issues_by_pid.get(p["id"], []):
                    mark = f"{GREEN}●{RESET}" if r["identifier"] in le else " "
                    who = f"  {DIM}{r['who'] or ''}{RESET}" if r["inprog"] else ""
                    print(f"{TAB}{TAB}{mark} {CYAN}{r['identifier']}{RESET} {r['title']}{who}")
        print()


def linear_graphql(query: str, variables: dict = None):
    key = _linear_key()
    if not key:
        print(f"{RED}No Linear key.{RESET} Set LINEAR_API_KEY or ~/.config/fleet/linear.key "
              f"(Linear > Settings > Security & access > Personal API keys).", file=sys.stderr)
        return None
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(LINEAR_URL, data=body, method="POST",
                                 headers={"Authorization": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"{RED}Linear error: {e}{RESET}", file=sys.stderr)
        return None


CLOSED_STATES = {"done", "completed", "canceled", "cancelled", "duplicate"}

def is_closed(status) -> bool:
    return (status or "").strip().lower() in CLOSED_STATES

_MY_ISSUES_Q = """
query {
  viewer {
    assignedIssues(first:100%FLT%) {
      nodes { identifier title url priorityLabel
              state{ name } project{ name initiatives(first:2){ nodes{ name } } } } }
    createdIssues(first:100%FLT%) {
      nodes { identifier title url priorityLabel
              state{ name } project{ name initiatives(first:2){ nodes{ name } } } } }
  }
}"""
_MINE_FILTER = ', filter:{ state:{ type:{ nin:["completed","canceled"] } } }'

def local_epics(repos) -> set:
    """ENG ids that currently have a local git worktree."""
    ids = set()
    for repo in repos:
        for line in sh(["git", "-C", str(repo), "worktree", "list", "--porcelain"]).splitlines():
            if line.startswith("branch "):
                e = epic_of(line[7:].removeprefix("refs/heads/"))
                if e:
                    ids.add(e)
    return ids

def show_my_issues(relation: str, repos, include_done: bool = False):
    q = _MY_ISSUES_Q.replace("%FLT%", "" if include_done else _MINE_FILTER)
    data = linear_graphql(q)
    if not data:
        return
    v = (data.get("data") or {}).get("viewer") or {}
    seen: dict = {}
    def add(nodes, rel):
        for n in nodes or []:
            e = seen.setdefault(n["identifier"], {**n, "_rel": set()})
            e["_rel"].add(rel)
    if relation in ("both", "assigned"):
        add((v.get("assignedIssues") or {}).get("nodes"), "assigned")
    if relation in ("both", "created"):
        add((v.get("createdIssues") or {}).get("nodes"), "created")

    local = local_epics(repos)
    # nest: initiative -> project -> issues
    tree: dict = {}
    for ident, n in seen.items():
        proj = n.get("project") or {}
        inits = [x["name"] for x in ((proj.get("initiatives") or {}).get("nodes") or [])]
        ini = inits[0] if inits else "~no initiative"
        pr = proj.get("name") or "~no project"
        tree.setdefault(ini, {}).setdefault(pr, []).append(n)

    rel_lbl = {"both": "assigned to or created by you", "assigned": "assigned to you", "created": "created by you"}
    scope = "all states" if include_done else "open"
    print(f"\n{BOLD}YOUR LINEAR TASKS{RESET}  {DIM}{rel_lbl[relation]} · {scope} · "
          f"{len(seen)} issues · {GREEN}{sum(1 for i in seen if i in local)} started locally{RESET}\n")
    TAB = "    "
    for ini in sorted(tree):
        print(f"{BOLD}{MAG}{ini}{RESET}")
        for pr in sorted(tree[ini]):
            print(f"{TAB}{BOLD}{pr}{RESET}")
            for n in sorted(tree[ini][pr], key=lambda x: x["identifier"]):
                ident = n["identifier"]
                mark = f"{GREEN}●{RESET}" if ident in local else " "
                st = n.get("state", {}).get("name", "")
                rel = "+".join(sorted(n["_rel"]))
                loc = f"  {GREEN}local wt{RESET}" if ident in local else ""
                print(f"{TAB}{TAB}{mark} {CYAN}{ident}{RESET} {n.get('title','')}  "
                      f"{DIM}[{st}] · {rel}{RESET}{loc}")
        print()


# ---- live agent detection ----------------------------------------------------
# Match the running coding-agent CLIs. Kinds mirror kanban's agentId enum
# (claude/codex/gemini/opencode/droid/kiro/cline) plus the kanban runtime itself.
AGENT_PATTERNS = [
    ("claude", re.compile(r"(?:^|/)claude\b|\bclaude\s+(?:--|-p|code|chat|resume)")),
    ("cline", re.compile(r"cline-core")),
    ("codex", re.compile(r"(?:^|/)codex(?:-cli)?\b|/codex/")),
    ("gemini", re.compile(r"(?:^|/)gemini\b")),
    ("opencode", re.compile(r"(?:^|/)opencode\b")),
    ("droid", re.compile(r"(?:^|/)droid\b|factory-?droid")),
    ("kiro", re.compile(r"(?:^|/)kiro\b")),
    ("kanban", re.compile(r"/\.bin/kanban|kanban/dist/cli\.js")),
]

def discover_agents() -> list[tuple[int, str]]:
    """Return [(pid, agent_kind, cwd)] for running coding-agent processes."""
    out = sh(["ps", "-eo", "pid=,command="])
    agents = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        pid_s, _, cmd = line.partition(" ")
        if not pid_s.isdigit():
            continue
        if "Claude.app" in cmd or "Claude Helper" in cmd or "chrome-native" in cmd or "fleet" in cmd:
            continue
        for kind, pat in AGENT_PATTERNS:
            if pat.search(cmd):
                agents.append((int(pid_s), kind))
                break
    # resolve cwd per pid via lsof
    resolved = []
    for pid, kind in agents:
        cwd = sh(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"])
        path = ""
        for l in cwd.splitlines():
            if l.startswith("n"):
                path = l[1:]
                break
        if path:
            resolved.append((pid, kind, path))
    return resolved


def agent_for(path: str, agents) -> tuple[str, int] | None:
    p = os.path.realpath(path)
    for pid, kind, cwd in agents:
        rc = os.path.realpath(cwd)
        if rc == p or rc.startswith(p + os.sep):
            return (kind, pid)
    return None


# ---- git worktree source -----------------------------------------------------
def discover_repos(roots: list[Path]) -> list[Path]:
    """Find git common-dirs under roots (dedup shared worktrees)."""
    seen, repos = set(), []
    for root in roots:
        root = root.expanduser()
        if not root.exists():
            continue
        candidates = [root] + [d for d in root.iterdir() if d.is_dir()] if root.is_dir() else [root]
        for d in candidates:
            common = sh(["git", "-C", str(d), "rev-parse", "--path-format=absolute", "--git-common-dir"])
            if not common:
                continue
            key = os.path.realpath(common)
            if key in seen:
                continue
            seen.add(key)
            repos.append(d)
    return repos


def worktree_rows(repos: list[Path], agents) -> list[dict]:
    rows = []
    for repo in repos:
        porcelain = sh(["git", "-C", str(repo), "worktree", "list", "--porcelain"])
        wt = branch = None
        detached = False
        for line in porcelain.splitlines() + [""]:
            if line.startswith("worktree "):
                wt, branch, detached = line[9:], None, False
            elif line.startswith("branch "):
                branch = line[7:].removeprefix("refs/heads/")
            elif line.startswith("detached"):
                detached = True
            elif line == "" and wt:
                rows.append(_wt_row(wt, branch, detached, agents))
                wt = None
    return rows


def _wt_row(path, branch, detached, agents) -> dict:
    branch = branch or ("(detached)" if detached else "?")
    base = sh(["git", "-C", path, "rev-parse", "--abbrev-ref", "origin/HEAD"]).removeprefix("origin/") or "main"
    dirty = len([l for l in sh(["git", "-C", path, "status", "--porcelain"]).splitlines() if l])
    ab = sh(["git", "-C", path, "rev-list", "--left-right", "--count", f"origin/{base}...HEAD"])
    behind = ahead = 0
    if ab and "\t" in ab:
        b, a = ab.split("\t")[:2]
        behind, ahead = int(b or 0), int(a or 0)
    last = sh(["git", "-C", path, "log", "-1", "--format=%cr"])
    ag = agent_for(path, agents)
    port, running = port_info(path)
    return {
        "source": "git", "repo": Path(path).name, "path": path, "branch": branch,
        "base": base, "dirty": dirty, "ahead": ahead, "behind": behind, "last": last,
        "agent": ag[0] if ag else None, "pid": ag[1] if ag else None,
        "port": port, "running": running,
        "epic": epic_of(branch, path),
        "status": _infer_status(ag, dirty, ahead),
    }


def _infer_status(agent, dirty, ahead):
    if agent: return "in_progress"
    if dirty: return "wip"
    if ahead: return "review"
    return "idle"


# ---- kanban source -----------------------------------------------------------
def kanban_rows(agents) -> list[dict]:
    idx = _read_json(KANBAN_HOME / "workspaces" / "index.json") or {}
    if isinstance(idx, dict) and isinstance(idx.get("entries"), (dict, list)):
        idx = idx["entries"]
    if isinstance(idx, list):  # normalize [{workspaceId, repoPath}, ...]
        idx = {e.get("workspaceId", str(i)): e for i, e in enumerate(idx) if isinstance(e, dict)}
    rows = []
    for ws_id, entry in idx.items():
        if not isinstance(entry, dict):
            continue
        ws_dir = KANBAN_HOME / "workspaces" / ws_id
        repo_label = Path(entry.get("repoPath", ws_id)).name
        board = _read_json(ws_dir / "board.json") or {}
        sessions = _read_json(ws_dir / "sessions.json") or {}
        sess = _index_sessions(sessions)
        for col in board.get("columns", []):
            for card in col.get("cards", []):
                tid = card.get("id")
                title = card.get("title") or (card.get("prompt", "")[:60])
                s = sess.get(tid, {})
                wt = s.get("workspacePath") or str(KANBAN_WORKTREES / (tid or "") / repo_label)
                ag = agent_for(wt, agents) if wt else None
                rows.append({
                    "source": "kanban", "repo": repo_label, "path": wt,
                    "branch": card.get("baseRef", "?"), "base": card.get("baseRef", "?"),
                    "title": title, "column": col.get("id"),
                    "agent": (s.get("agentId") or card.get("agentId")),
                    "session_state": s.get("state"),
                    "pid": s.get("pid"),
                    "activity": (s.get("latestHookActivity") or {}).get("summary") if isinstance(s.get("latestHookActivity"), dict) else s.get("latestHookActivity"),
                    "epic": epic_of(title, card.get("prompt"), card.get("baseRef")),
                    "status": col.get("id"),
                })
    return rows


def _index_sessions(sessions):
    if isinstance(sessions, dict) and "sessions" in sessions:
        sessions = sessions["sessions"]
    out = {}
    if isinstance(sessions, list):
        for s in sessions:
            if isinstance(s, dict) and s.get("taskId"):
                out[s["taskId"]] = s
    elif isinstance(sessions, dict):
        for k, v in sessions.items():
            if isinstance(v, dict):
                out[v.get("taskId", k)] = v
    return out


def _read_json(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


# ---- ports (from port-for registry) ------------------------------------------
_PORTS: dict = {}

def load_ports():
    _PORTS.clear()
    _PORTS.update(_read_json(PORTS_REG) or {})

def port_info(path: str):
    port = _PORTS.get(os.path.realpath(path))
    if not port:
        return None, False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.1)
        return port, s.connect_ex(("127.0.0.1", port)) == 0


# ---- rendering ---------------------------------------------------------------
STATUS_COLOR = {"in_progress": GREEN, "wip": YELLOW, "review": CYAN, "idle": DIM,
                "backlog": DIM, "done": DIM, "trash": DIM}

def render(rows: list[dict], hidden: int = 0):
    epics: dict[str, list[dict]] = {}
    for r in rows:
        epics.setdefault(r["epic"] or "~untagged", []).append(r)

    def epic_sort(k):
        if k == "~untagged": return (2, 0, "")
        m = re.match(r"ENG-(\d+)", k)
        return (0, -int(m.group(1)) if m else 0, k)

    live = sum(1 for r in rows if r.get("agent") and r["status"] == "in_progress")
    hid = f" · {hidden} done hidden ({BOLD}--all{RESET}{DIM} to show)" if hidden else ""
    print(f"\n{BOLD}FLEET{RESET}  {DIM}{len(rows)} work items · {len(epics)} epics · "
          f"{GREEN}{live} live agents{RESET}{DIM}{hid} · {time.strftime('%H:%M:%S')}{RESET}\n")

    for ek in sorted(epics, key=epic_sort):
        items = epics[ek]
        if ek == "~untagged":
            head = f"{DIM}(no ENG reference){RESET}"
        else:
            meta = epic_meta(ek)
            extra = ""
            if meta.get("project") or meta.get("initiative"):
                parts = [p for p in (meta.get("initiative"), meta.get("project")) if p]
                extra = f" {DIM}· {' / '.join(parts)}{RESET}"
            title = f" {meta['title']}" if meta.get("title") else ""
            status = f" {CYAN}[{meta['status']}]{RESET}" if meta.get("status") else ""
            head = f"{BOLD}{MAG}{ek}{RESET}{title}{status}{extra}"
        print(f"{head}  {DIM}({len(items)}){RESET}")
        for r in sorted(items, key=lambda r: (r["status"] != "in_progress", r["repo"])):
            print("   " + _fmt_row(r))
        print()


def _fmt_row(r) -> str:
    dot = f"{GREEN}●{RESET}" if r.get("agent") and r["status"] == "in_progress" else \
          (f"{DIM}○{RESET}" if r.get("agent") else " ")
    col = STATUS_COLOR.get(r["status"], "")
    label = r.get("title") or r["branch"]
    who = f"{BLUE}{r['agent']}{RESET}" if r.get("agent") else f"{DIM}—{RESET}"
    src = f"{DIM}{r['repo']}{RESET}"
    bits = []
    if r["source"] == "git":
        if r.get("port"):
            bits.append(f"{GREEN}:{r['port']}▶{RESET}" if r.get("running") else f"{DIM}:{r['port']}{RESET}")
        if r.get("dirty"): bits.append(f"{YELLOW}{r['dirty']}✗{RESET}")
        if r.get("ahead") or r.get("behind"): bits.append(f"{DIM}+{r['ahead']}/-{r['behind']}{RESET}")
        if r.get("last"): bits.append(f"{DIM}{r['last']}{RESET}")
    else:
        bits.append(f"{col}[{r.get('column','?')}]{RESET}")
        if r.get("activity"): bits.append(f"{DIM}{str(r['activity'])[:40]}{RESET}")
    meta = "  ".join(bits)
    return f"{dot} {col}{label[:44]:<44}{RESET} {who:<16} {src:<22} {meta}"


# ---- config / main -----------------------------------------------------------
def load_config():
    return _read_json(CONFIG) or {}

def resolve_roots(args, cfg) -> list[Path]:
    if args.root:
        return [Path(r).expanduser() for r in args.root]
    if PROJECT_DIR:                       # inside a `.fleet` project
        return [PROJECT_DIR]
    return [Path(cfg.get("default_root", "~/code/repos")).expanduser()]


def main():
    ap = argparse.ArgumentParser(description="Epic-grouped view of parallel agent work")
    ap.add_argument("--root", action="append", help="repo root to scan (repeatable); default = the .fleet project you're in")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--no-agents", action="store_true", help="skip live-agent detection")
    ap.add_argument("--no-kanban", action="store_true", help="skip kanban board source")
    ap.add_argument("--no-linear", action="store_true", help="skip Linear enrichment")
    ap.add_argument("--all", action="store_true", help="include Done/closed items (hidden by default)")
    ap.add_argument("--mine", action="store_true", help="list YOUR Linear issues (assigned or created)")
    ap.add_argument("--initiatives", action="store_true", help="list Linear initiatives (active by default)")
    ap.add_argument("--issues", action="store_true", help="with --initiatives: also drill into issues")
    ap.add_argument("--agent-plan", metavar="ENG-ID", help="plan: Linear issue -> design-doc card")
    ap.add_argument("--agent-implement", metavar="ENG-ID", help="implement: design -> code + /ship card")
    ap.add_argument("--repo", help="with --agent-start: target repo (default: first in project)")
    ap.add_argument("--agent", default="claude", help="with --agent-start: agent id (default claude)")
    ap.add_argument("--no-start", action="store_true", help="with --agent-start: create card but don't start it")
    ap.add_argument("--assigned", action="store_true", help="with --mine: only issues assigned to you")
    ap.add_argument("--created", action="store_true", help="with --mine: only issues you created")
    args = ap.parse_args()
    cfg = load_config()
    roots = resolve_roots(args, cfg)
    if args.agent_plan:
        sys.exit(agent_plan(args.agent_plan, args.repo, args.agent, cfg, start=not args.no_start))
    if args.agent_implement:
        sys.exit(agent_implement(args.agent_implement, args.repo, args.agent, cfg, start=not args.no_start))
    if args.initiatives:
        show_initiatives(discover_repos(roots), include_all=args.all, show_issues=args.issues)
        return
    if args.mine:
        relation = "assigned" if args.assigned and not args.created else \
                   "created" if args.created and not args.assigned else "both"
        show_my_issues(relation, discover_repos(roots), include_done=args.all)
        return
    agents = [] if args.no_agents else discover_agents()
    load_ports()
    repos = discover_repos(roots)
    rows = worktree_rows(repos, agents)
    if not args.no_kanban:
        rows += kanban_rows(agents)
    if not args.no_linear:
        prefetch_epics({r["epic"] for r in rows if r.get("epic")}, team=cfg.get("linear_team"))
    hidden = 0
    if not args.all:
        kept = []
        for r in rows:
            e = r.get("epic")
            if e and is_closed(epic_meta(e).get("status")):
                hidden += 1
            else:
                kept.append(r)
        rows = kept
    if args.json:
        for r in rows:
            r["epic_meta"] = epic_meta(r["epic"]) if r.get("epic") else None
        print(json.dumps({"generated": time.time(), "rows": rows}, indent=2))
    else:
        render(rows, hidden)


if __name__ == "__main__":
    main()
