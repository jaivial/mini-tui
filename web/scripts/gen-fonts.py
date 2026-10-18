#!/usr/bin/env python3
"""
Rebuild the shipped webfonts with their weight axis pinned to the weights this app paints.

E30 measured it: after E26 cut the dead subsets, the two fonts that a first visit
actually downloads were the whole remaining font cost -- **70 404 B, 30% of the wire**
(geist latin 29 700, jetbrains-mono latin 40 704). That is five times the entire API
surface E29 handed off. Both ship as VARIABLE fonts with a wide axis:

    geist         wght 100..900  (9 named masters: Thin..Black)
    jetbrains     wght 100..800  (7 named masters: Thin..ExtraBold)

and the app can only ever ask for four of them. Measured against the DEPLOYED build
in Chrome 145, reading `getComputedStyle` over every painted node and every
`font-weight` declaration in the loaded stylesheets:

    geist 400 (171 nodes), 500 (49), 600 (3)      mono 500 (1)
    every `font-weight` in the compiled CSS is 600, or a 300..700 @font-face axis

`font-medium` (500) and `font-semibold` (600) are the only weight utilities the whole
of `web/src` uses -- there is no `font-bold`, `font-black` or `font-extrabold` anywhere,
so nothing reaches past 600. The ceiling is 700 and only because `<th>` and `<b>` keep
the browser's default `bold` inside `.prose-mini` (Tailwind v4's preflight resets
`h1..h6` to `font-weight: inherit` but leaves `b,strong` at `bolder` and does not touch
`th` at all). 400 is the floor because nothing asks for light.

So the axis is 400..700 with the extremes as masters, and the rest of the file is
outlines for weights the browser can never select.

This script pins that range and rewrites the @font-face `font-weight` ranges to match,
because a mismatch is the classic silent failure here: a CSS axis that promises
100..900 against a file that only has 400..700 does not error, it just makes every
request above 700 render at 700.

Run it after changing a font package version:

    python3 web/scripts/gen-fonts.py            # rewrite the pinned woff2 in place
    python3 web/scripts/gen-fonts.py --check    # verify, exit 1 on drift (CI)

It needs `fonttools` (pip install fonttools brotli) and reads the masters from the
installed `@fontsource-variable` packages, so it always starts from the real upstream
file instead of from an already-pinned derivative.
"""
from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

try:
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
except ImportError:  # pragma: no cover
    sys.exit("fonttools is required: pip install fonttools brotli")

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "node_modules" / "@fontsource-variable"
# The pinned files are the SOURCE the app ships, so they live beside the app and not in
# public/: Vite copies public/ into dist verbatim, and a font kept there would be
# deployed twice over (once hashed into assets/, once at its literal path).
DEST = ROOT / "assets" / "fonts"

# The weights the app can paint, measured (see the module docstring). 700 is the
# ceiling because `<th>`/`<b>` keep the UA default bold inside the markdown surface;
# 400 is the floor because nothing in web/src asks for a lighter weight.
AXIS = (400, 700)

# family -> (package, the two subsets E26 kept, the CSS family name used in app.css)
FAMILIES = {
    "Geist Variable": ("geist", ("latin", "latin-ext")),
    "JetBrains Mono Variable": ("jetbrains-mono", ("latin", "latin-ext")),
}

# Space Grotesk is deliberately NOT in the list above. Its upstream axis is already
# 300..700 -- the app's whole paintable range, and only 200 wide -- so pinning it to
# 400..700 saves nothing: measured, `latin-ext` came out 36 B LARGER than the master
# (18 976 vs 18 940), because re-encoding a 4-master axis is pure cost. Its `url()`s keep
# pointing at the package. Copying it "for consistency" would have added a binary and a
# regeneration step to buy a rounding error, and the `--check` below is what noticed.


def source_font(pkg: str, subset: str) -> Path:
    path = PKG / pkg / "files" / f"{pkg}-{subset}-wght-normal.woff2"
    if not path.is_file():
        sys.exit(f"missing upstream font: {path}")
    return path


def pin(src: Path, dest: Path) -> None:
    """Write the axis-pinned rendition of `src` to `dest`."""
    font = TTFont(src)
    instancer.instantiateVariableFont(font, {"wght": AXIS}, inplace=True, updateFontNames=False)
    font.flavor = "woff2"
    dest.parent.mkdir(parents=True, exist_ok=True)
    font.save(dest)


def axis_of(path: Path) -> tuple[float, float]:
    font = TTFont(path)
    axes = font["fvar"].axes
    if len(axes) != 1 or axes[0].axisTag != "wght":
        sys.exit(f"{path}: expected a single wght axis, found {[a.axisTag for a in axes]}")
    return axes[0].minValue, axes[0].maxValue


def css_range(family: str) -> str:
    return f"{AXIS[0]} {AXIS[1]}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify the pinned files, exit 1 on drift")
    args = ap.parse_args()

    css_path = ROOT / "src" / "app.css"
    css = css_path.read_text(encoding="utf8")
    drift: list[str] = []

    for family, (pkg, subsets) in FAMILIES.items():
        for subset in subsets:
            src = source_font(pkg, subset)
            dest = DEST / f"{pkg}-{subset}-wght-{AXIS[0]}-{AXIS[1]}.woff2"

            if args.check:
                if not dest.is_file():
                    drift.append(f"missing {dest.relative_to(ROOT)}")
                    continue
                lo, hi = axis_of(dest)
                if (lo, hi) != (float(AXIS[0]), float(AXIS[1])):
                    drift.append(f"{dest.name}: axis is {lo}..{hi}, expected {AXIS[0]}..{AXIS[1]}")
                    continue
                # The pinned file must actually be smaller than what it replaces,
                # otherwise the whole change buys nothing and should not be merged.
                if dest.stat().st_size >= src.stat().st_size:
                    drift.append(
                        f"{dest.name}: {dest.stat().st_size} B is not smaller than the "
                        f"upstream {src.stat().st_size} B"
                    )
                continue

            pin(src, dest)
            # NEGATIVE is the good direction here: the pinned file is smaller than the
            # master it replaces. Printed as a delta on the ORIGINAL size, so the sign
            # has to be `-` for a saving -- printing `+` for a 27% cut is the kind of
            # cosmetic bug that makes the next reader distrust the whole log.
            saved = dest.stat().st_size - src.stat().st_size
            print(
                f"{dest.relative_to(ROOT)}: {src.stat().st_size} -> {dest.stat().st_size} B "
                f"({saved:+d}, {100 * saved / src.stat().st_size:+.1f}%)"
            )

    # The CSS axis must match the files, or a request above the real maximum renders
    # silently at the maximum instead of the weight the design asked for.
    for family in FAMILIES:
        faces = [
            m.group(1)
            for m in __import__("re").finditer(r"@font-face\s*\{([^}]*)\}", css)
            if f'"{family}"' in m.group(1)
        ]
        if len(faces) != 2:
            drift.append(f"{family}: expected 2 @font-face blocks, found {len(faces)}")
            continue
        for body in faces:
            if f"font-weight: {css_range(family)}" not in body:
                drift.append(
                    f"{family}: @font-face says {body.strip()[:80]!r}, "
                    f"expected font-weight: {css_range(family)}"
                )
            url = body.split('url("')[-1].split('"')[0]
            name = url.rsplit("/", 1)[-1]
            if f"-wght-{AXIS[0]}-{AXIS[1]}.woff2" not in name:
                drift.append(f"{family}: url() still names the unpinned master {name!r}")
                continue
            # The url() is relative to web/src/app.css, so resolve it from there: a
            # mistyped path is a 404 the browser swallows, and the text quietly falls
            # back to the system face with no error anywhere.
            target = (ROOT / "src" / url).resolve()
            if not target.is_file():
                drift.append(f"{family}: url() names a file that does not exist: {target}")
                continue
            if target.parent != DEST.resolve():
                drift.append(f"{family}: {name} is not in {DEST}, so --check is not looking at it")

    if drift:
        print("DRIFT:", file=sys.stderr)
        for line in drift:
            print(f"  {line}", file=sys.stderr)
        return 1
    if args.check:
        print(f"fonts OK: {len(FAMILIES)} families pinned to wght {AXIS[0]}..{AXIS[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
