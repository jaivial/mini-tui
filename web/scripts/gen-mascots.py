#!/usr/bin/env python3
"""
Rebuild the mascot renditions from the 560px masters.

E29 measured it: the only consumer (`Mascot.svelte`, rendered at 56 CSS px) was
being handed a 593x560 image. That is 10x more pixels than any screen can show, and
the pet was the third-largest file of a first visit (30 774 B, 11.8% of the wire).

This script derives, for every mood, the three square renditions the browser can
actually pick (1x / 2x / 3x of 56px). Square matters: `Mascot.svelte` puts the image
in a square box with `object-contain`, so padding to a square is bit-identical on
screen (measured: max per-pixel delta 0 at 56, 112 and 168) while making the
`srcset` width descriptors exact.

Run it after changing a master:

    python3 web/scripts/gen-mascots.py            # rewrite the renditions in place
    python3 web/scripts/gen-mascots.py --check    # verify, exit 1 on drift (CI)

It needs `cwebp` (libwebp). The masters live in web/assets/mascot-master/, deliberately
OUTSIDE web/public/ (Vite copies public/ verbatim into dist, so a master kept there
would be deployed). They are the source of truth, so a re-run always starts from the
original 560px art instead of from an already-downscaled derivative.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path
from shutil import which

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "public" / "mascots"
# OUTSIDE public/ ON PURPOSE: Vite copies everything under public/ into dist
# verbatim, so masters kept there would be served (measured: 227 700 B of 560px art
# in the deploy) even though no page ever requests them.
MASTERS = ROOT / "assets" / "mascot-master"

# The one size the app paints the pet at, and the pixel densities worth shipping.
# 3x covers every phone screen; going wider costs bytes nobody can see.
BASE = 56
DENSITIES = (1, 2, 3)

# Lossy, quality 90, with sharp_yuv: the pet is a flat-shaded cartoon with a soft
# alpha edge, where chroma subsampling shows as a halo against a flat page. Measured
# against the master at true screen resolution: mean error ~2.4/255 on the alpha
# border in BOTH light and dark, p95 8.
QUALITY = "90"
ALPHA_QUALITY = "100"

MOODS = {
    "float": "idle",
    "laptop": "thinking",
    "headset": "speaking",
    "sleep": "offline",
    "celebrate": "happy",
    "coffee": "break",
    "wave": "wave",
    "point": "point",
}


def master_size(path: Path) -> tuple[int, int]:
    """Pixel size of a WebP, from its VP8X/VP8L/VP8 header chunk."""
    data = path.read_bytes()
    if data[12:16] == b"VP8X":
        return (
            int.from_bytes(data[24:27], "little") + 1,
            int.from_bytes(data[27:30], "little") + 1,
        )
    if data[12:16] == b"VP8L":
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if data[12:16] == b"VP8 ":
        return (
            int.from_bytes(data[26:28], "little") & 0x3FFF,
            int.from_bytes(data[28:30], "little") & 0x3FFF,
        )
    raise SystemExit(f"{path.name}: not a WebP I can read ({data[12:16]!r})")


def encode(src: Path, dst: Path, box: int) -> None:
    """Fit the long edge to `box` and pad the short one to a square, then encode.

    The pad has to happen BEFORE the encode: cwebp has `-resize` but no `-pad`, and
    `-resize box 0` only scales proportionally, so on its own it yields a 112x162 file
    for a 388x560 master — which is exactly the drift `--check` is there to catch.
    `object-contain` would compute the same padding at paint time, so baking it in is
    not a visual change (measured: max per-pixel delta 0) and it makes the `srcset`
    width descriptors exact.
    """
    from PIL import Image

    with Image.open(src) as im:
        rgba = im.convert("RGBA")
        scale = box / max(rgba.size)
        fitted = (
            max(1, round(rgba.width * scale)),
            max(1, round(rgba.height * scale)),
        )
        resized = rgba.resize(fitted, Image.LANCZOS)
        square = Image.new("RGBA", (box, box), (0, 0, 0, 0))
        square.alpha_composite(resized, ((box - fitted[0]) // 2, (box - fitted[1]) // 2))
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            staged = Path(tmp.name)
        try:
            square.save(staged, format="PNG")
            subprocess.run(
                [
                    "cwebp", "-quiet",
                    "-q", QUALITY,
                    "-alpha_q", ALPHA_QUALITY,
                    "-m", "6",
                    "-sharp_yuv",
                    str(staged), "-o", str(dst),
                ],
                check=True,
            )
        finally:
            staged.unlink(missing_ok=True)


def alpha_coverage(path: Path) -> float:
    """Fraction of the image that is not fully transparent."""
    from PIL import Image

    with Image.open(path) as im:
        alpha = im.convert("RGBA").getchannel("A")
        hist = alpha.histogram()
    opaque_or_partial = sum(hist[1:])
    return opaque_or_partial / (alpha.width * alpha.height)


def rendition_name(mood: str, box: int) -> str:
    return f"{mood}-{box}.webp"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify only, exit 1 on drift")
    args = ap.parse_args()

    if not which("cwebp"):
        raise SystemExit("cwebp not found: install libwebp to rebuild the renditions")

    drift: list[str] = []
    total = 0
    for mood in MOODS:
        master = MASTERS / f"{mood}.webp"
        if not master.exists():
            drift.append(f"missing master {master.relative_to(ROOT)}")
            continue
        mw, mh = master_size(master)
        for density in DENSITIES:
            box = BASE * density
            out = DIR / rendition_name(mood, box)
            if args.check:
                if not out.exists():
                    drift.append(f"missing rendition {out.name}")
                    continue
                w, h = master_size(out)
                if (w, h) != (box, box):
                    drift.append(f"{out.name} is {w}x{h}, expected {box}x{box}")
                    continue
                # Square and present is not enough: a blank, truncated or flat-grey file
                # has the right dimensions. Check there is an actual pet in there — an
                # alpha-coverage ratio close to the master's, scaled by area.
                # Coverage is a RATIO, so it does not scale with area: the same pet on
                # a smaller box covers the same fraction of it (slightly more, in fact,
                # because the transparent border is thinned first).
                expected = alpha_coverage(master)
                coverage = alpha_coverage(out)
                if not 0.5 * expected <= coverage <= 1.5 * expected:
                    drift.append(
                        f"{out.name} covers {coverage:.1%} of its box where the master "
                        f"covers {expected:.1%} — blank, truncated, or not the same art"
                    )
                    continue
                total += out.stat().st_size
                continue
            encode(master, out, box)
            total += out.stat().st_size
            print(f"{out.name:<24} {box}px  {out.stat().st_size:>6} B")

    if args.check:
        if drift:
            for line in drift:
                print(f"drift: {line}", file=sys.stderr)
            return 1
        print(f"OK: {len(MOODS) * len(DENSITIES)} renditions, {total} B in total")
        return 0

    print(f"\n{len(MOODS) * len(DENSITIES)} renditions, {total} B in total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
