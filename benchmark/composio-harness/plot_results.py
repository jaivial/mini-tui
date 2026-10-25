#!/usr/bin/env python3
"""Plot Composio's published Kimi K3 harness results, optionally adding a validated mini-tui run.

No third-party chart package is needed beyond Pillow. With no --mini argument the script plots
only the published reference. A mini result is accepted only with 25 unique, individually scored
tasks and local evidence; this prevents numbers from another corpus entering the comparison.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

BENCHMARK_ID = "composio-kimi-k3-25-v1"
BG = "#171717"
FG = "#E7E7E7"
MUTED = "#858585"
GRID = "#383838"
MINI_COLOR = "#2DD4BF"
FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
    "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf",
    "/usr/share/fonts/open-sans/OpenSans-Regular.ttf",
    "/usr/share/fonts/adwaita-sans-fonts/AdwaitaSans-Regular.ttf",
)


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def load_mini(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text())
    if raw.get("benchmark_id") != BENCHMARK_ID:
        raise ValueError(f"mini benchmark_id must be {BENCHMARK_ID!r}; another corpus is not comparable")
    if raw.get("run_complete") is not True:
        raise ValueError("mini run is not complete")
    if raw.get("attempts_per_task") != 1 or raw.get("timeout_seconds") != 900:
        raise ValueError("mini must use one scored attempt per task and the 900-second ceiling")
    if "k3" not in str(raw.get("model", "")).lower():
        raise ValueError("mini result is not a Kimi K3 run")
    tasks = raw.get("task_results")
    if not isinstance(tasks, list) or len(tasks) != 25:
        raise ValueError("mini must contain exactly 25 task_results")
    ids = [t.get("task_id") for t in tasks]
    if len(set(ids)) != 25 or any(not isinstance(i, str) or not i for i in ids):
        raise ValueError("task_results must have 25 unique, non-empty task_id values")
    for task in tasks:
        if type(task.get("passed")) is not bool:
            raise ValueError(f"{task.get('task_id')}: passed must be boolean")
        wall = task.get("wall_seconds")
        if not isinstance(wall, (int, float)) or not math.isfinite(wall) or wall < 0 or wall > 900:
            raise ValueError(f"{task['task_id']}: wall_seconds must be within 0..900")
        calls = task.get("tool_calls")
        if type(calls) is not int or calls < 0:
            raise ValueError(f"{task['task_id']}: tool_calls must be a non-negative integer")
    evidence = raw.get("evidence_files")
    if not isinstance(evidence, list) or not evidence:
        raise ValueError("evidence_files must point to the raw run artifacts")
    for item in evidence:
        artifact = (path.parent / str(item)).resolve()
        if not artifact.is_file() or artifact.stat().st_size == 0:
            raise ValueError(f"missing or empty evidence artifact: {artifact}")

    usage_ids = raw.get("usage_task_ids")
    total_tokens = None
    if usage_ids is not None:
        if not isinstance(usage_ids, list) or len(usage_ids) != 24 or set(usage_ids) > set(ids):
            raise ValueError("usage_task_ids must name exactly 24 tasks from the scored set")
        by_id = {t["task_id"]: t for t in tasks}
        values = [by_id[i].get("total_tokens") for i in usage_ids]
        if any(type(v) is not int or v < 0 for v in values):
            raise ValueError("every usage task needs non-negative integer total_tokens")
        total_tokens = sum(values) / 1_000_000
    cost = raw.get("total_cost_usd")
    if cost is not None and (not isinstance(cost, (int, float)) or not math.isfinite(cost) or cost < 0):
        raise ValueError("total_cost_usd must be null or a non-negative number")
    return {
        "name": str(raw.get("harness") or "mini-tui") + " (ours)",
        "tasks_passed": sum(t["passed"] for t in tasks),
        "pass_rate_percent": 100 * sum(t["passed"] for t in tasks) / 25,
        "median_time_seconds": statistics.median(t["wall_seconds"] for t in tasks),
        "tool_calls": sum(t["tool_calls"] for t in tasks),
        "cost_per_success_usd": raw.get("cost_per_success_usd"),
        "total_tokens_millions": total_tokens,
        "total_cost_usd": cost,
        "color": MINI_COLOR,
        "provider": raw.get("provider", "Kimi for Coding (direct)"),
        "run_label": raw.get("run_label", path.stem),
    }


def nice_max(value: float) -> float:
    if value <= 0:
        return 1
    raw = value * 1.08
    magnitude = 10 ** math.floor(math.log10(raw))
    for multiple in (1, 2, 2.5, 5, 10):
        if raw <= multiple * magnitude:
            return multiple * magnitude
    return 10 * magnitude


def fmt_tick(value: float, prefix: str = "", suffix: str = "") -> str:
    if abs(value - round(value)) < 1e-8:
        body = str(int(round(value)))
    else:
        body = f"{value:.1f}"
    return f"{prefix}{body}{suffix}"


def draw_chart(rows: list[dict[str, Any]], metric: str, title: str, output: Path,
               formatter, descending: bool, prefix: str = "", suffix: str = "",
               fixed_max: float | None = None, footer: str = "") -> None:
    ordered = sorted(rows, key=lambda r: (r[metric] is None, r[metric] or 0), reverse=descending)
    width, left, right, top, row_h, bottom = 1600, 385, 1390, 130, 76, 86
    height = top + row_h * len(ordered) + bottom
    im = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(im)
    title_font, label_font, tick_font, value_font, foot_font = font(31), font(27), font(22), font(27), font(18)
    d.text((48, 28), title, fill=FG, font=title_font)
    measured = [float(r[metric]) for r in ordered if r[metric] is not None]
    maximum = fixed_max or nice_max(max(measured, default=1))
    bar_width = right - left
    for i in range(5):
        value = maximum * i / 4
        x = round(left + bar_width * i / 4)
        d.line((x, 82, x, height - bottom + 5), fill=GRID, width=1)
        label = fmt_tick(value, prefix, suffix)
        bbox = d.textbbox((0, 0), label, font=tick_font)
        d.text((x - (bbox[2] - bbox[0]) / 2, 82 - 31), label, fill=MUTED, font=tick_font)
    for index, row in enumerate(ordered):
        y = top + index * row_h
        name = row["name"]
        d.text((48, y + 11), name, fill=FG, font=label_font)
        value = row[metric]
        if value is not None:
            end = left + max(2, round(bar_width * float(value) / maximum))
            d.rectangle((left, y, end, y + 43), fill=row.get("color", MINI_COLOR))
            if row["name"].endswith("(ours)"):
                d.rectangle((left - 3, y - 3, end + 3, y + 46), outline=FG, width=2)
            label = formatter(float(value), row)
        else:
            d.rectangle((left, y, left + 2, y + 43), fill=GRID)
            label = "N/A"
        d.text((right + 25, y + 8), label, fill=FG, font=value_font)
    if footer:
        d.text((48, height - 45), footer, fill=MUTED, font=foot_font)
    im.save(output)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--published", type=Path, default=Path(__file__).with_name("published_kimi_k3.json"))
    parser.add_argument("--mini", type=Path, help="validated mini-tui result JSON; omit for published-only charts")
    parser.add_argument("--out-dir", type=Path, default=Path(__file__).with_name("charts"))
    args = parser.parse_args()
    published = json.loads(args.published.read_text())
    if published.get("benchmark_id") != BENCHMARK_ID or len(published.get("harnesses", [])) != 8:
        raise ValueError("unexpected published reference schema")
    rows = list(published["harnesses"])
    footer = "Source: Composio, 4 Aug 2026 (published results; 25 tasks, Kimi K3 via OpenRouter)."
    prefix = "published"
    if args.mini:
        mini = load_mini(args.mini)
        rows.append(mini)
        footer += f" Ours: {mini['run_label']}, {mini['provider']}; same 25-task evidence required."
        prefix = "with-mini"
    args.out_dir.mkdir(parents=True, exist_ok=True)
    draw_chart(rows, "pass_rate_percent", "Kimi K3 harness pass rate (25 tasks)",
               args.out_dir / f"{prefix}-pass-rate.png",
               lambda v, r: f"{r['tasks_passed']}/25 · {v:.0f}%", True,
               suffix="%", fixed_max=100, footer=footer)
    draw_chart(rows, "median_time_seconds", "Median wall time per task (lower is better)",
               args.out_dir / f"{prefix}-median-time.png",
               lambda v, r: f"{v:.1f}s", False, suffix="s", footer=footer)
    draw_chart(rows, "total_tokens_millions", "Total token use · shared 24-task slice (lower is better)",
               args.out_dir / f"{prefix}-tokens.png",
               lambda v, r: f"{v:.2f}M", False, suffix="M", footer=footer)
    draw_chart(rows, "total_cost_usd", "Estimated API cost · shared 24-task slice (lower is better)",
               args.out_dir / f"{prefix}-cost.png",
               lambda v, r: f"${v:.2f}", False, prefix="$", footer=footer)
    summary = [{k: r.get(k) for k in ("name", "tasks_passed", "pass_rate_percent", "median_time_seconds", "tool_calls", "total_tokens_millions", "total_cost_usd")} for r in rows]
    (args.out_dir / f"{prefix}-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"wrote four charts and summary to {args.out_dir}")


if __name__ == "__main__":
    main()
