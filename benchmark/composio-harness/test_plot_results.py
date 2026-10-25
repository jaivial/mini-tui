#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

import plot_results


class MiniResultValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "summary.json").write_text("{}\n")

    def tearDown(self):
        self.tmp.cleanup()

    def result(self):
        return {
            "benchmark_id": "composio-kimi-k3-25-v1",
            "harness": "mini-tui",
            "model": "kimi-coding/k3",
            "provider": "Kimi for Coding (direct)",
            "run_complete": True,
            "attempts_per_task": 1,
            "timeout_seconds": 900,
            "evidence_files": ["summary.json"],
            "task_results": [
                {"task_id": f"golden.test.{i}", "passed": i != 24, "wall_seconds": i + 1,
                 "tool_calls": 2, "total_tokens": 100}
                for i in range(25)
            ],
            "usage_task_ids": [f"golden.test.{i}" for i in range(24)],
            "total_cost_usd": None,
        }

    def write(self, value):
        path = self.root / "result.json"
        path.write_text(json.dumps(value))
        return path

    def test_computes_aggregates_from_task_rows(self):
        row = plot_results.load_mini(self.write(self.result()))
        self.assertEqual(row["tasks_passed"], 24)
        self.assertEqual(row["pass_rate_percent"], 96)
        self.assertEqual(row["median_time_seconds"], 13)
        self.assertEqual(row["tool_calls"], 50)
        self.assertAlmostEqual(row["total_tokens_millions"], 0.0024)
        self.assertIsNone(row["total_cost_usd"])

    def test_rejects_another_corpus(self):
        value = self.result()
        value["benchmark_id"] = "local-ten-task-corpus"
        with self.assertRaisesRegex(ValueError, "another corpus"):
            plot_results.load_mini(self.write(value))

    def test_rejects_missing_task_and_evidence(self):
        value = self.result()
        value["task_results"].pop()
        with self.assertRaisesRegex(ValueError, "exactly 25"):
            plot_results.load_mini(self.write(value))
        value = self.result()
        value["evidence_files"] = ["missing.json"]
        with self.assertRaisesRegex(ValueError, "missing or empty evidence"):
            plot_results.load_mini(self.write(value))

    def test_rejects_partial_or_incomparable_usage(self):
        value = self.result()
        value["run_complete"] = False
        with self.assertRaisesRegex(ValueError, "not complete"):
            plot_results.load_mini(self.write(value))
        value = self.result()
        value["usage_task_ids"] = value["usage_task_ids"][:-1]
        with self.assertRaisesRegex(ValueError, "exactly 24"):
            plot_results.load_mini(self.write(value))


if __name__ == "__main__":
    unittest.main()
