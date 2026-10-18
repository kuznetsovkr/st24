"""Offline checks of committed HTTP-monitor templates, not account acceptance."""

import json
from pathlib import Path
import re
import unittest
from urllib.parse import urlsplit


class MonitorTemplateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parent
        cls.monitors = []
        for name in ["cronitor-http-monitors.json", "cronitor-telegram-monitor.json"]:
            cls.monitors.extend(json.loads((root / name).read_text(encoding="utf-8"))["monitors"])
        cls.telegram = next(m for m in cls.monitors if m["key"] == "karcher-telegram-notifications")

    def test_distinct_stable_keys(self):
        self.assertEqual(len(self.monitors), 3)
        self.assertEqual(len({m["key"] for m in self.monitors}), len(self.monitors))

    def test_public_read_only_https_requests(self):
        for monitor in self.monitors:
            with self.subTest(key=monitor["key"]):
                self.assertEqual((monitor["type"], monitor["platform"]), ("check", "http"))
                request = monitor["request"]
                parsed = urlsplit(request["url"])
                self.assertEqual((parsed.scheme, parsed.hostname), ("https", "xn---24-3edf.xn--p1ai"))
                self.assertIsNone(parsed.username)
                self.assertIsNone(parsed.password)
                self.assertIsNone(parsed.port)
                self.assertEqual((parsed.query, parsed.fragment), ("", ""))
                self.assertEqual(request["method"], "GET")
                self.assertTrue(request["verify_ssl"])
                self.assertFalse(request["follow_redirects"])

    def test_schedule_timeout_and_notification_route(self):
        for monitor in self.monitors:
            self.assertEqual(monitor["schedule"], "every 5 minutes")
            self.assertEqual(monitor["request"]["timeout_seconds"], 10)
            self.assertEqual(monitor["notify"], ["default"])
            self.assertEqual(monitor["failure_tolerance"], 0)

    def test_telegram_monitors_notification_health_not_just_readiness(self):
        self.assertEqual(urlsplit(self.telegram["request"]["url"]).path, "/api/health/notifications")
        assertions = set(self.telegram["assertions"])
        self.assertTrue({
            "response.code = 200", "response.json status = ok",
            "response.json worker.status = ok", "response.json outbox.dead = 0",
            "response.json invariants.failedLeadNotifications = 0",
            "response.header Content-Type contains application/json",
            "response.header Cache-Control contains no-store",
        }.issubset(assertions))
        self.assertNotIn("response.json outbox.pending = 0", assertions)
        self.assertNotIn("response.json outbox.retry = 0", assertions)

    def test_no_private_headers_or_live_credentials(self):
        for monitor in self.monitors:
            self.assertEqual(monitor["request"]["headers"], {"Cache-Control": "no-cache"})
            serialized = json.dumps(monitor)
            self.assertIsNone(re.search(r"cronitor\.link/p/|bot\d{5,}:|AGE-SECRET-KEY-|PRIVATE KEY", serialized))


if __name__ == "__main__":
    unittest.main()
