#!/usr/bin/env python3
"""Render captured TUI frames (docs/screenshots/*.json) into PNG screenshots.

Usage: python3 scripts/render-screenshots.py
Input: docs/screenshots/<scene>.json  (written by scripts/capture-scenes.test.tsx)
Output: docs/screenshots/<scene>.png
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent.parent
SHOTS = HERE / "docs" / "screenshots"
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

FONT_SIZE = 20
LINE_HEIGHT = 27
MARGIN = 16
DEFAULT_BG = "#0d1117"
DEFAULT_FG = "#e6edf3"


def render(scene: Path) -> None:
    data = json.loads(scene.read_text())
    cols, rows = data["cols"], data["rows"]
    lines = data["lines"]

    font = ImageFont.truetype(FONT_PATH, FONT_SIZE)
    cell_w = font.getlength("M")
    width = int(cell_w * cols + MARGIN * 2)
    height = LINE_HEIGHT * rows + MARGIN * 2

    image = Image.new("RGB", (width, height), DEFAULT_BG)
    draw = ImageDraw.Draw(image)

    for row, spans in enumerate(lines):
        y = MARGIN + row * LINE_HEIGHT
        x = MARGIN
        for span in spans:
            text = span["text"]
            if not text:
                continue
            bg = span.get("bg")
            if bg:
                tw = cell_w * len(text)
                draw.rectangle([x, y, x + tw, y + LINE_HEIGHT], fill=bg)
            draw.text((x, y + 2), text, font=font, fill=span.get("fg") or DEFAULT_FG)
            x += cell_w * len(text)

    out = scene.with_suffix(".png")
    image.save(out)
    print(f"{out.name}: {width}x{height}")


def main() -> None:
    scenes = sorted(SHOTS.glob("*.json"))
    if not scenes:
        raise SystemExit("No captured scenes found. Run: MINITUI_CAPTURE=1 bun test scripts/capture-scenes.test.tsx")
    for scene in scenes:
        render(scene)


if __name__ == "__main__":
    main()
