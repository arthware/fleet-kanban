#!/usr/bin/env python3
"""
fleet budget — remaining session/window budget for the local coding agents.

Two providers, two very different budget models — reported through one shape so an
agent can steer on `min(remaining_percent)` and back off before it hits a wall:

  codex   — the ChatGPT backend pushes a rate-limit snapshot on every turn. We read
            it for free from the newest session rollout under $CODEX_HOME/sessions:
            a `primary` 5-hour window + a `secondary` weekly window, each a
            used_percent + reset time. No network, no token cost; only as fresh as
            Codex's last turn (see `stale_seconds`).

  claude  — Claude Code's OAuth token (macOS Keychain / ~/.claude/.credentials.json,
            auto-refreshed by the CLI) as a Bearer against
            https://api.anthropic.com/api/oauth/usage. Native 5-hour + weekly windows
            (like Codex), plus per-model weekly scopes and an extra-usage overage pool.

  cursor  — no local cache. The token lives in the desktop app's SQLite state DB;
            we POST it to https://cursor.com/api/usage-summary (first-party, the
            user's own account) and read the monthly included-usage pool + the
            on-demand overage bucket. There is NO 5h/weekly window here — Cursor's
            budget is a single monthly billing cycle, so that's the window we report.

Normalized provider shape (also what `--json` emits):
    { provider, plan, source: "rollout"|"api", stale_seconds, error?,
      windows: [ { name, used_percent, remaining_percent, resets_at, detail? } ] }

Usage:
    fleet budget            # unified table
    fleet budget --json     # machine-readable, for agent steering
    fleet budget --no-cursor / --no-codex
"""
from __future__ import annotations
import argparse, base64, json, os, sqlite3, sys, tempfile, time, urllib.request, urllib.error
from pathlib import Path

HOME = Path.home()
CURSOR_STATE_DB = HOME / "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
CURSOR_USAGE_URL = "https://cursor.com/api/usage-summary"
CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"
CLAUDE_OAUTH_BETA = "oauth-2025-04-20"


# ── normalization (pure — the unit-tested core) ─────────────────────────────

def _pct(used):
    """used_percent → (used, remaining) rounded, clamped to [0,100]."""
    u = max(0.0, min(100.0, round(float(used), 1)))
    return u, round(100.0 - u, 1)


def codex_windows(rate_limits, snapshot_ts=None, now=None):
    """Codex `rate_limits` block → normalized provider dict.

    `primary` is the 5-hour session window, `secondary` the weekly one; either may
    be absent on a fresh account. `snapshot_ts` (unix) dates the snapshot so callers
    can see how stale the free local read is.
    """
    if not rate_limits:
        return None
    now = now if now is not None else int(time.time())
    names = {300: "5h", 10080: "week"}
    windows = []
    for key in ("primary", "secondary"):
        w = rate_limits.get(key)
        if not w:
            continue
        used, remaining = _pct(w.get("used_percent", 0))
        mins = w.get("window_minutes")
        windows.append({
            "name": names.get(mins, f"{mins}m" if mins else key),
            "window_minutes": mins,
            "used_percent": used,
            "remaining_percent": remaining,
            "resets_at": w.get("resets_at"),
        })
    return {
        "provider": "codex",
        "plan": rate_limits.get("plan_type"),
        "source": "rollout",
        "stale_seconds": (now - snapshot_ts) if snapshot_ts else None,
        "windows": windows,
    }


def cursor_windows(summary, now=None):
    """Cursor `usage-summary` JSON → normalized provider dict.

    `cycle` = the monthly included-usage pool (`totalPercentUsed` is authoritative —
    it already blends auto + API use). `on-demand` = the pay-as-you-go overage bucket
    that fills up to the account's hard spend limit. Both reset at the billing-cycle
    end, so that's the shared `resets_at`.
    """
    if not summary:
        return None
    resets_at = _iso_to_unix(summary.get("billingCycleEnd"))
    iu = (summary.get("individualUsage") or {})
    windows = []

    plan = iu.get("plan") or {}
    if plan:
        used, remaining = _pct(plan.get("totalPercentUsed", 0))
        windows.append({
            "name": "cycle",
            "used_percent": used,
            "remaining_percent": remaining,
            "resets_at": resets_at,
            "detail": f"{plan.get('used', 0)}/{plan.get('limit', 0)}",
        })

    od = iu.get("onDemand") or {}
    if od and od.get("enabled"):
        limit = od.get("limit") or 0
        used_raw = od.get("used") or 0
        used, remaining = _pct((used_raw / limit * 100) if limit else 0)
        windows.append({
            "name": "on-demand",
            "used_percent": used,
            "remaining_percent": remaining,
            "resets_at": resets_at,
            "detail": f"{used_raw}/{limit}",
        })

    return {
        "provider": "cursor",
        "plan": summary.get("membershipType"),
        "source": "api",
        "stale_seconds": 0,
        "windows": windows,
    }


def claude_windows(usage, plan=None, now=None):
    """Claude `oauth/usage` JSON → normalized provider dict.

    `five_hour` / `seven_day` are the session + weekly windows (utilization %), the
    same model as Codex. Any non-null per-model weekly scope (`seven_day_opus`,
    `seven_day_sonnet`, …) is surfaced as its own window, and `extra_usage` becomes an
    overage window only when it's actually enabled.
    """
    if not usage:
        return None
    windows = []

    def add(name, blk):
        if not blk:
            return
        used, remaining = _pct(blk.get("utilization", 0))
        windows.append({
            "name": name,
            "used_percent": used,
            "remaining_percent": remaining,
            "resets_at": _iso_to_unix(blk.get("resets_at")),
        })

    add("5h", usage.get("five_hour"))
    add("week", usage.get("seven_day"))
    for key, name in (("seven_day_opus", "week-opus"), ("seven_day_sonnet", "week-sonnet")):
        add(name, usage.get(key))

    ex = usage.get("extra_usage") or {}
    if ex.get("is_enabled"):
        used, remaining = _pct(ex.get("utilization", 0))
        windows.append({
            "name": "extra",
            "used_percent": used,
            "remaining_percent": remaining,
            "resets_at": None,
            "detail": f"{ex.get('used_credits')}/{ex.get('monthly_limit')} {ex.get('currency', '')}".strip(),
        })

    return {
        "provider": "claude",
        "plan": plan,
        "source": "api",
        "stale_seconds": 0,
        "windows": windows,
    }


def worst_remaining(provider):
    """The tightest window — what an agent should steer on. None if unknown."""
    vals = [w["remaining_percent"] for w in (provider or {}).get("windows", [])
            if w.get("remaining_percent") is not None]
    return min(vals) if vals else None


def _iso_to_unix(s):
    """ISO-8601 (with Z or offset) → unix seconds. None if unparseable."""
    if not s:
        return None
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


# ── codex I/O ───────────────────────────────────────────────────────────────

def codex_home():
    return Path(os.environ.get("CODEX_HOME") or (HOME / ".codex"))


def last_rate_limits(rollout_path):
    """Last `rate_limits` snapshot in a rollout file, with its event timestamp.

    Rollout files are append-only JSONL; the freshest snapshot is the last line that
    carries one. We only JSON-parse lines that mention rate_limits (cheap on big files).
    Returns (rate_limits, snapshot_unix) or (None, None).
    """
    found, ts = None, None
    try:
        with open(rollout_path, "r") as fh:
            for line in fh:
                if '"rate_limits"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                rl = (obj.get("payload") or {}).get("rate_limits")
                if rl:
                    found = rl
                    ts = _iso_to_unix(obj.get("timestamp"))
    except OSError:
        return None, None
    return found, ts


def read_codex(now=None):
    """Newest rollout that carries a rate-limit snapshot → normalized provider."""
    sessions = codex_home() / "sessions"
    if not sessions.is_dir():
        return {"provider": "codex", "error": f"no sessions dir at {sessions}"}
    rollouts = sorted(sessions.rglob("rollout-*.jsonl"),
                      key=lambda p: p.stat().st_mtime, reverse=True)
    for path in rollouts:
        rl, ts = last_rate_limits(path)
        if rl:
            return codex_windows(rl, snapshot_ts=ts, now=now)
    return {"provider": "codex", "error": "no rate-limit snapshot in any rollout yet"}


# ── cursor I/O ──────────────────────────────────────────────────────────────

def cursor_token(db_path=None):
    """(sub, jwt) from the Cursor desktop app's SQLite state DB, or None."""
    db_path = Path(db_path or os.environ.get("CURSOR_STATE_DB") or CURSOR_STATE_DB)
    if not db_path.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        row = con.execute(
            "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'").fetchone()
        con.close()
    except sqlite3.Error:
        return None
    if not row or not row[0]:
        return None
    jwt = row[0]
    try:
        seg = jwt.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4)))
        return payload["sub"], jwt
    except Exception:
        return None


def fetch_cursor_summary(sub, jwt, timeout=8):
    """POST the stored token to Cursor's first-party usage endpoint. Raises on failure."""
    req = urllib.request.Request(CURSOR_USAGE_URL, method="POST", data=b"{}")
    req.add_header("Cookie", f"WorkosCursorSessionToken={sub}::{jwt}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Origin", "https://cursor.com")
    req.add_header("Referer", "https://cursor.com/dashboard")
    req.add_header("User-Agent", "fleet-budget")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def read_cursor(now=None, fetch=fetch_cursor_summary, db_path=None):
    tok = cursor_token(db_path)
    if not tok:
        return {"provider": "cursor",
                "error": "no Cursor auth found (is the desktop app signed in?)"}
    sub, jwt = tok
    try:
        summary = fetch(sub, jwt)
    except urllib.error.HTTPError as e:
        return {"provider": "cursor", "error": f"HTTP {e.code} from usage-summary"}
    except Exception as e:  # timeout, DNS, offline …
        return {"provider": "cursor", "error": f"request failed: {e}"}
    return cursor_windows(summary, now=now)


# ── claude I/O ──────────────────────────────────────────────────────────────

def claude_token():
    """Claude Code's OAuth access token — env override, then macOS Keychain, then
    ~/.claude/.credentials.json. Returned for use only; callers must never print it."""
    env = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if env:
        return env
    # macOS Keychain (where Claude Code stores it on darwin)
    try:
        import subprocess
        raw = subprocess.run(
            ["security", "find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, timeout=8).stdout.strip()
        if raw:
            return json.loads(raw).get("claudeAiOauth", {}).get("accessToken")
    except Exception:
        pass
    # portable fallback
    cred = HOME / ".claude" / ".credentials.json"
    if cred.exists():
        try:
            return json.loads(cred.read_text()).get("claudeAiOauth", {}).get("accessToken")
        except Exception:
            return None
    return None


def _anthropic_get(url, token, timeout=8):
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("anthropic-beta", CLAUDE_OAUTH_BETA)
    req.add_header("User-Agent", "fleet-budget")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def fetch_claude_usage(token, timeout=8):
    return _anthropic_get(CLAUDE_USAGE_URL, token, timeout)


def fetch_claude_plan(token, timeout=8):
    """Best-effort plan label from oauth/profile (max / pro). None on any failure."""
    try:
        prof = _anthropic_get("https://api.anthropic.com/api/oauth/profile", token, timeout)
        acct = prof.get("account") or {}
        if acct.get("has_claude_max"):
            return "max"
        if acct.get("has_claude_pro"):
            return "pro"
    except Exception:
        pass
    return None


def read_claude(now=None, fetch_usage=fetch_claude_usage, fetch_plan=fetch_claude_plan):
    token = claude_token()
    if not token:
        return {"provider": "claude",
                "error": "no Claude Code auth found (sign in with `claude`)"}
    try:
        usage = fetch_usage(token)
    except urllib.error.HTTPError as e:
        hint = " — token expired, run `claude` to refresh" if e.code in (401, 403) else ""
        return {"provider": "claude", "error": f"HTTP {e.code} from oauth/usage{hint}"}
    except Exception as e:
        return {"provider": "claude", "error": f"request failed: {e}"}
    plan = fetch_plan(token)
    return claude_windows(usage, plan=plan, now=now)


# ── rendering ───────────────────────────────────────────────────────────────

def _fmt_reset(resets_at, now):
    if not resets_at:
        return ""
    delta = resets_at - now
    if delta <= 0:
        return "resets now"
    h, m = delta // 3600, (delta % 3600) // 60
    when = f"{h}h{m:02d}m" if h else f"{m}m"
    return f"resets in {when}"


def _color(remaining):
    if remaining is None:
        return ""
    if remaining <= 10:
        return "\033[31m"   # red
    if remaining <= 25:
        return "\033[33m"   # yellow
    return "\033[32m"       # green


def format_banner(providers, now=None, color=True, indent="  "):
    """The table nested under a dim `budget` label — for the head of `fleet task ls`."""
    D = "\033[2m" if color else ""
    R = "\033[0m" if color else ""
    body = format_table(providers, now=now, color=color)
    lines = "\n".join(indent + ln for ln in body.splitlines())
    return f"{D}budget{R}  {D}(remaining per window — steer heavy dispatch on the lowest){R}\n{lines}"


def format_table(providers, now=None, color=True):
    now = now if now is not None else int(time.time())
    R = "\033[0m" if color else ""
    lines = []
    for p in providers:
        name = p.get("provider", "?")
        if p.get("error"):
            lines.append(f"{name:<8} \033[90m{p['error']}{R}" if color
                         else f"{name:<8} {p['error']}")
            continue
        plan = p.get("plan") or "?"
        head = f"{name:<8}{plan:<6}"
        stale = p.get("stale_seconds")
        cells = []
        for w in p.get("windows", []):
            rem = w.get("remaining_percent")
            c = _color(rem) if color else ""
            reset = _fmt_reset(w.get("resets_at"), now)
            detail = f" {w['detail']}" if w.get("detail") else ""
            cell = f"{w['name']:<9} {c}{rem:>5.1f}% left{R}{detail}"
            if reset:
                cell += f"  \033[90m{reset}{R}" if color else f"  {reset}"
            cells.append(cell)
        row = head + "   ".join(cells)
        if stale and stale > 90:
            mins = stale // 60
            age = f"{mins//60}h{mins%60:02d}m" if mins >= 60 else f"{mins}m"
            row += f"   \033[90m(snapshot {age} old){R}" if color else f"   (snapshot {age} old)"
        lines.append(row)
    return "\n".join(lines)


# ── cli ─────────────────────────────────────────────────────────────────────

def build_report(claude=True, codex=True, cursor=True, now=None,
                 read_claude=read_claude, read_codex=read_codex, read_cursor=read_cursor):
    now = now if now is not None else int(time.time())
    providers = []
    if claude:
        providers.append(read_claude(now=now))
    if codex:
        providers.append(read_codex(now=now))
    if cursor:
        providers.append(read_cursor(now=now))
    return [p for p in providers if p]


def _cache_file():
    return Path(os.environ.get("FLEET_BUDGET_CACHE")
                or Path(tempfile.gettempdir()) / "fleet-budget.json")


def _read_cache(ttl, now):
    """Cached providers if the cache is younger than `ttl` seconds, else None."""
    try:
        blob = json.loads(_cache_file().read_text())
        if 0 <= now - int(blob.get("generated_at", 0)) <= ttl:
            return blob.get("providers")
    except Exception:
        pass
    return None


def _write_cache(providers, now):
    try:
        _cache_file().write_text(json.dumps({"generated_at": now, "providers": providers}))
    except Exception:
        pass


def get_report(now=None, use_cache=False, ttl=60, **kw):
    """Report with an optional short-TTL file cache — so `fleet task ls` can show the
    budget on every call without re-hitting the network each time. A fresh build always
    refreshes the cache, so `fleet budget` warms it for the surrounding task list."""
    now = now if now is not None else int(time.time())
    if use_cache:
        cached = _read_cache(ttl, now)
        if cached is not None:
            return cached
    report = build_report(now=now, **kw)
    _write_cache(report, now)
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(prog="fleet budget",
                                 description="Remaining session/window budget for local coding agents.")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--no-claude", action="store_true")
    ap.add_argument("--no-codex", action="store_true")
    ap.add_argument("--no-cursor", action="store_true")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--cached", action="store_true",
                    help="use the short-TTL cache instead of fetching fresh")
    args = ap.parse_args(argv)

    now = int(time.time())
    providers = get_report(now=now, use_cache=args.cached,
                           claude=not args.no_claude, codex=not args.no_codex,
                           cursor=not args.no_cursor)

    if args.json:
        for p in providers:
            p["worst_remaining_percent"] = worst_remaining(p)
        print(json.dumps({"generated_at": now, "providers": providers}, indent=2))
        return 0

    if not providers:
        print("no providers selected")
        return 0
    color = sys.stdout.isatty() and not args.no_color
    print(format_table(providers, now=now, color=color))
    return 0


if __name__ == "__main__":
    sys.exit(main())
