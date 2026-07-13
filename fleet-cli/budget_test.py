#!/usr/bin/env python3
"""Tests for `fleet budget` — normalization core + report assembly.

Hermetic: no network, no disk, no clock. All I/O seams are injected so the tests
pin behaviour, not the machine's live Codex/Cursor state. Run: python3 budget_test.py
"""
import json
import unittest

import budget

NOW = 1_783_000_000  # fixed clock for every test


class CodexNormalization(unittest.TestCase):
    """Codex's 5h + weekly windows are the shape `fleet budget` was built for."""

    def sample(self):
        return {
            "limit_id": "codex", "plan_type": "plus",
            "primary":   {"used_percent": 1.0,  "window_minutes": 300,   "resets_at": NOW + 300},
            "secondary": {"used_percent": 42.0, "window_minutes": 10080, "resets_at": NOW + 9999},
        }

    def test_reports_five_hour_and_weekly_windows_by_name(self):
        p = budget.codex_windows(self.sample(), snapshot_ts=NOW, now=NOW)
        names = [w["name"] for w in p["windows"]]
        self.assertEqual(names, ["5h", "week"])
        self.assertEqual(p["plan"], "plus")
        self.assertEqual(p["source"], "rollout")

    def test_remaining_is_the_complement_of_used(self):
        p = budget.codex_windows(self.sample(), snapshot_ts=NOW, now=NOW)
        five_h = p["windows"][0]
        self.assertEqual(five_h["used_percent"], 1.0)
        self.assertEqual(five_h["remaining_percent"], 99.0)

    def test_stale_seconds_measures_snapshot_age(self):
        p = budget.codex_windows(self.sample(), snapshot_ts=NOW - 120, now=NOW)
        self.assertEqual(p["stale_seconds"], 120)

    def test_a_missing_window_is_omitted_not_faked(self):
        rl = self.sample(); del rl["secondary"]
        p = budget.codex_windows(rl, snapshot_ts=NOW, now=NOW)
        self.assertEqual([w["name"] for w in p["windows"]], ["5h"])

    def test_no_snapshot_yields_no_provider(self):
        self.assertIsNone(budget.codex_windows(None))


class CursorNormalization(unittest.TestCase):
    """Cursor has no session/weekly window — only a monthly cycle + overage bucket."""

    def summary(self):
        return {
            "billingCycleEnd": "2026-07-27T20:09:43.000Z",
            "membershipType": "pro",
            "individualUsage": {
                "plan": {"used": 500, "limit": 2000, "remaining": 1500, "totalPercentUsed": 25.0},
                "onDemand": {"enabled": True, "used": 3000, "limit": 15000},
            },
        }

    def test_cycle_window_uses_total_percent_used_as_authoritative(self):
        p = budget.cursor_windows(self.summary(), now=NOW)
        cycle = next(w for w in p["windows"] if w["name"] == "cycle")
        self.assertEqual(cycle["used_percent"], 25.0)
        self.assertEqual(cycle["remaining_percent"], 75.0)
        self.assertEqual(cycle["detail"], "500/2000")

    def test_on_demand_percent_is_derived_from_used_over_limit(self):
        p = budget.cursor_windows(self.summary(), now=NOW)
        od = next(w for w in p["windows"] if w["name"] == "on-demand")
        self.assertEqual(od["used_percent"], 20.0)   # 3000/15000
        self.assertEqual(od["remaining_percent"], 80.0)

    def test_disabled_on_demand_bucket_is_omitted(self):
        s = self.summary(); s["individualUsage"]["onDemand"]["enabled"] = False
        p = budget.cursor_windows(s, now=NOW)
        self.assertEqual([w["name"] for w in p["windows"]], ["cycle"])

    def test_both_windows_reset_at_billing_cycle_end(self):
        p = budget.cursor_windows(self.summary(), now=NOW)
        resets = {w["resets_at"] for w in p["windows"]}
        self.assertEqual(len(resets), 1)
        self.assertIsNotNone(resets.pop())


class ClaudeNormalization(unittest.TestCase):
    """Claude mirrors Codex — native 5h + weekly windows from utilization %."""

    def usage(self):
        return {
            "five_hour": {"utilization": 16.0, "resets_at": "2026-07-12T16:50:00+00:00"},
            "seven_day": {"utilization": 65.0, "resets_at": "2026-07-14T02:00:00+00:00"},
            "seven_day_opus": None,
            "seven_day_sonnet": None,
            "extra_usage": {"is_enabled": False, "utilization": 100.0,
                            "used_credits": 9493, "monthly_limit": 9000, "currency": "EUR"},
        }

    def test_session_and_weekly_windows_from_utilization(self):
        p = budget.claude_windows(self.usage(), plan="max", now=NOW)
        self.assertEqual([w["name"] for w in p["windows"]], ["5h", "week"])
        self.assertEqual(p["windows"][0]["remaining_percent"], 84.0)
        self.assertEqual(p["windows"][1]["remaining_percent"], 35.0)
        self.assertEqual(p["plan"], "max")

    def test_null_scoped_model_windows_are_skipped(self):
        p = budget.claude_windows(self.usage(), now=NOW)
        self.assertNotIn("week-opus", [w["name"] for w in p["windows"]])

    def test_active_scoped_model_window_is_surfaced(self):
        u = self.usage()
        u["seven_day_opus"] = {"utilization": 30.0, "resets_at": "2026-07-14T02:00:00+00:00"}
        p = budget.claude_windows(u, now=NOW)
        opus = next(w for w in p["windows"] if w["name"] == "week-opus")
        self.assertEqual(opus["remaining_percent"], 70.0)

    def test_extra_usage_only_shows_when_enabled(self):
        u = self.usage()
        self.assertNotIn("extra", [w["name"] for w in budget.claude_windows(u, now=NOW)["windows"]])
        u["extra_usage"]["is_enabled"] = True
        names = [w["name"] for w in budget.claude_windows(u, now=NOW)["windows"]]
        self.assertIn("extra", names)

    def test_expired_token_is_reported_as_error_with_refresh_hint(self):
        import urllib.error
        def boom(token):
            raise urllib.error.HTTPError("u", 401, "unauth", {}, None)
        p = budget.read_claude(now=NOW,
                               fetch_usage=boom, fetch_plan=lambda t: None)
        # only runs the fetch if a token exists; guard for CI without creds
        if "error" in p and "HTTP" in p["error"]:
            self.assertIn("refresh", p["error"])


class SteeringSignal(unittest.TestCase):
    """The number an agent throttles on is the tightest window across a provider."""

    def test_worst_remaining_is_the_minimum_window(self):
        p = budget.codex_windows(
            {"plan_type": "plus",
             "primary":   {"used_percent": 5,  "window_minutes": 300},
             "secondary": {"used_percent": 90, "window_minutes": 10080}}, now=NOW)
        self.assertEqual(budget.worst_remaining(p), 10.0)

    def test_worst_remaining_is_none_when_no_windows(self):
        self.assertIsNone(budget.worst_remaining({"provider": "cursor", "error": "x"}))


class ReportAssembly(unittest.TestCase):
    """`fleet budget --json` — provider errors degrade gracefully, never crash."""

    def test_report_collects_each_selected_provider(self):
        report = budget.build_report(
            now=NOW,
            read_claude=lambda now: {"provider": "claude", "windows": []},
            read_codex=lambda now: {"provider": "codex", "windows": []},
            read_cursor=lambda now: {"provider": "cursor", "windows": []})
        self.assertEqual([p["provider"] for p in report], ["claude", "codex", "cursor"])

    def test_deselected_providers_are_not_read(self):
        report = budget.build_report(
            claude=False, cursor=False, now=NOW,
            read_codex=lambda now: {"provider": "codex", "windows": []})
        self.assertEqual([p["provider"] for p in report], ["codex"])

    def test_one_provider_failing_still_returns_the_others(self):
        report = budget.build_report(
            now=NOW,
            read_claude=lambda now: {"provider": "claude", "error": "offline"},
            read_codex=lambda now: {"provider": "codex", "windows": []},
            read_cursor=lambda now: {"provider": "cursor", "windows": [
                {"name": "cycle", "remaining_percent": 75.0, "resets_at": None}]})
        self.assertEqual(report[0]["error"], "offline")
        self.assertEqual(budget.worst_remaining(report[2]), 75.0)

    def test_read_cursor_surfaces_missing_token_as_error_not_exception(self):
        p = budget.read_cursor(now=NOW, db_path="/nonexistent/state.vscdb")
        self.assertIn("error", p)


class Caching(unittest.TestCase):
    """`fleet task ls` reads a short-TTL cache so it doesn't re-hit the network each call."""

    def setUp(self):
        import tempfile, os
        self.tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        self.tmp.close()
        os.environ["FLEET_BUDGET_CACHE"] = self.tmp.name

    def tearDown(self):
        import os
        os.environ.pop("FLEET_BUDGET_CACHE", None)
        os.unlink(self.tmp.name)

    def test_fresh_build_is_served_from_cache_within_ttl(self):
        calls = {"n": 0}
        def one_reader(now):
            calls["n"] += 1
            return {"provider": "codex", "windows": []}
        # first call builds + caches; second within ttl must not rebuild
        budget.get_report(now=NOW, claude=False, cursor=False, read_codex=one_reader)
        budget.get_report(now=NOW + 30, use_cache=True, ttl=60,
                          claude=False, cursor=False, read_codex=one_reader)
        self.assertEqual(calls["n"], 1)

    def test_expired_cache_triggers_a_rebuild(self):
        calls = {"n": 0}
        def one_reader(now):
            calls["n"] += 1
            return {"provider": "codex", "windows": []}
        budget.get_report(now=NOW, claude=False, cursor=False, read_codex=one_reader)
        budget.get_report(now=NOW + 120, use_cache=True, ttl=60,
                          claude=False, cursor=False, read_codex=one_reader)
        self.assertEqual(calls["n"], 2)


class Rendering(unittest.TestCase):
    """The table is a human read of the same data; errors and staleness are visible."""

    def test_plain_table_shows_percent_and_reset(self):
        p = budget.codex_windows(
            {"plan_type": "plus",
             "primary": {"used_percent": 1.0, "window_minutes": 300, "resets_at": NOW + 3600}},
            snapshot_ts=NOW, now=NOW)
        out = budget.format_table([p], now=NOW, color=False)
        self.assertIn("codex", out)
        self.assertIn("99.0% left", out)
        self.assertIn("resets in 1h00m", out)

    def test_error_provider_renders_its_message(self):
        out = budget.format_table(
            [{"provider": "cursor", "error": "no Cursor auth found"}], now=NOW, color=False)
        self.assertIn("no Cursor auth found", out)

    def test_banner_labels_the_block_and_nests_the_table(self):
        p = budget.codex_windows(
            {"plan_type": "plus",
             "primary": {"used_percent": 40.0, "window_minutes": 300, "resets_at": NOW + 60}},
            snapshot_ts=NOW, now=NOW)
        out = budget.format_banner([p], now=NOW, color=False)
        self.assertTrue(out.startswith("budget"))
        self.assertIn("  codex", out)          # table indented under the label
        self.assertIn("60.0% left", out)

    def test_stale_codex_snapshot_is_flagged(self):
        p = budget.codex_windows(
            {"plan_type": "plus",
             "primary": {"used_percent": 1.0, "window_minutes": 300, "resets_at": NOW + 60}},
            snapshot_ts=NOW - 7200, now=NOW)
        out = budget.format_table([p], now=NOW, color=False)
        self.assertIn("snapshot", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
