#!/usr/bin/env python3
"""Render TestSlop's README visual assets.

The renderer never invents output: it runs the two real, runnable demos,
captures their UTF-8 stdout, and only then lays the captured text out in a
polished terminal frame. A few assertions fail the run if the tool's output
ever stops matching what the assets claim to show.

Assets produced:

  assets/hero/testslop-hero.gif              animated hero (README top)
  assets/hero/testslop-hero.png              strongest static frame
  assets/diagrams/how-it-works.png           concept diagram (PNG)
  assets/diagrams/how-it-works.svg           concept diagram (SVG)
  assets/screenshots/ms-historical-example.png   vercel/ms replay
  assets/social/testslop-share.png           1200x630 share card
  assets/social/testslop-hero.mp4            hero demo as MP4 (needs ffmpeg)

Requirements: Python 3.10+ and Pillow. ffmpeg is optional (MP4 only).
Regenerate after `npm run build`:  python scripts/render-assets.py
"""

from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow")

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"

# Restrained palette: neutral dark terminal, green for passing tests, a single
# cool red for the Evil Twin, amber for the witness.
BG = "#0d1117"
PANEL = "#161b22"
BORDER = "#30363d"
TEXT = "#e6edf3"
DIM = "#8b949e"
GREEN = "#3fb950"
ACCENT = "#ff7b72"
AMBER = "#e3b341"
AMBER_PANEL = "#2b2313"
AMBER_PANEL_HOT = "#3a2f14"

MONO_FILES = [
    "CascadiaMono.ttf",
    "CascadiaCode.ttf",
    "DejaVuSansMono.ttf",
    "LiberationMono-Regular.ttf",
    "UbuntuMono-R.ttf",
    "cour.ttf",
]
SANS_FILES = ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf"]
SANS_BOLD_FILES = ["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf"]

FONT_DIRS = [
    Path(os.environ["WINDIR"]) / "Fonts" if os.name == "nt" else Path("/nonexistent"),
    Path.home() / "AppData/Local/Microsoft/Windows/Fonts",
    Path("/usr/share/fonts/truetype/dejavu"),
    Path("/usr/share/fonts/truetype/liberation"),
    Path("/usr/share/fonts"),
    Path("/Library/Fonts"),
    Path("/System/Library/Fonts"),
]

_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}
_path_cache: dict[str, Path | None] = {}


def find_font(candidates: list[str]) -> Path:
    key = "|".join(candidates)
    if key in _path_cache:
        found = _path_cache[key]
        if found is None:
            raise FileNotFoundError(f"none of the expected fonts found: {candidates}")
        return found
    for directory in FONT_DIRS:
        if not directory.exists():
            continue
        for name in candidates:
            direct = directory / name
            if direct.is_file():
                _path_cache[key] = direct
                return direct
    for directory in FONT_DIRS:
        if not directory.exists():
            continue
        for name in candidates:
            matches = list(directory.rglob(name))
            if matches:
                _path_cache[key] = matches[0]
                return matches[0]
    _path_cache[key] = None
    raise FileNotFoundError(f"none of the expected fonts found: {candidates}")


def mono_font(size: int) -> ImageFont.FreeTypeFont:
    key = ("mono", size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(str(find_font(MONO_FILES)), size)
    return _font_cache[key]


def sans_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    key = ("sans-bold" if bold else "sans", size)
    if key not in _font_cache:
        files = SANS_BOLD_FILES if bold else SANS_FILES
        _font_cache[key] = ImageFont.truetype(str(find_font(files)), size)
    return _font_cache[key]


class Seg:
    """One run of text in a terminal row."""

    def __init__(self, text: str, fill: str = TEXT, bold: bool = False, mono: bool = True, size: int = 0):
        self.text = text
        self.fill = fill
        self.bold = bold
        self.mono = mono
        self.size = size  # 0 = inherit the row font size


class Row:
    def __init__(self, stage: int, segs: list[Seg], prompt: bool = False):
        self.stage = stage
        self.segs = segs
        self.prompt = prompt


def stroke_for(size: int, bold: bool) -> int:
    """Faux bold: a 1px stroke renders heavier without needing a bold face."""
    if not bold:
        return 0
    return max(1, round(size / 24))


def seg_width(seg: Seg, base_size: int) -> float:
    size = seg.size or base_size
    font = mono_font(size) if seg.mono else sans_font(size, seg.bold)
    return font.getlength(seg.text) + stroke_for(size, seg.bold)


def draw_segs(d: ImageDraw.ImageDraw, x: float, y: float, segs: list[Seg], base_size: int) -> None:
    for seg in segs:
        size = seg.size or base_size
        font = mono_font(size) if seg.mono else sans_font(size, seg.bold)
        # Mono faces ship no bold file here, so weight them with a stroke. Sans bold
        # already comes from the real bold face — a stroke on top would double it.
        stroke = stroke_for(size, seg.bold) if seg.mono else 0
        d.text((x, y), seg.text, font=font, fill=seg.fill, stroke_width=stroke, stroke_fill=seg.fill)
        x += font.getlength(seg.text) + stroke


# --------------------------------------------------------------------------------------
# Capturing the real demos
# --------------------------------------------------------------------------------------

def npm_run(script: str) -> None:
    if os.name == "nt":
        subprocess.run(["cmd", "/d", "/s", "/c", f"npm run {script}"], cwd=ROOT, check=True)
    else:
        subprocess.run(["npm", "run", script], cwd=ROOT, check=True)


def run_node(script: str) -> str:
    if not (ROOT / "dist" / "cli.js").exists():
        print("dist/cli.js missing — running `npm run build` first")
        npm_run("build")
    result = subprocess.run(
        ["node", str(ROOT / "scripts" / script)],
        cwd=ROOT,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"{script} exited with {result.returncode}:\n{result.stdout}\n{result.stderr}")
    return result.stdout


def clean_report(raw: str, drop_location: bool) -> list[str]:
    # Drop the tool's own "TestSlop" banner wherever it appears; everything else
    # stays exactly as the demo printed it.
    lines = [line.rstrip() for line in raw.splitlines() if line.strip() != "TestSlop"]
    while lines and not lines[-1].strip():
        lines.pop()
    while lines and not lines[0].strip():
        lines.pop(0)
    if drop_location:
        while lines and not lines[-1].strip():
            lines.pop()
        if lines and re.fullmatch(r"\s+\S+\.\w+:\d+", lines[-1]):
            lines.pop()
        while lines and not lines[-1].strip():
            lines.pop()
    return lines


def expect(haystack: str, *needles: str) -> None:
    for needle in needles:
        if needle not in haystack:
            raise RuntimeError(f"demo output no longer matches the assets; missing: {needle!r}")


# --------------------------------------------------------------------------------------
# Terminal styling
# --------------------------------------------------------------------------------------

def style_line(text: str, twin_code: bool) -> list[Seg]:
    s = text.strip()
    if s.startswith("$ "):
        return [Seg("$ ", GREEN, True), Seg(s[2:], TEXT)]
    if s == "Your implementation:":
        return [Seg(s, DIM)]
    if s == "Evil Twin:":
        return [Seg(s, ACCENT, True)]
    if twin_code:
        return [Seg(text, ACCENT)]
    if s.startswith("Your tests accept"):
        before, after = s.split("BOTH", 1)
        return [Seg(before, TEXT, True), Seg("BOTH", ACCENT, True), Seg(after, TEXT, True)]
    if s == "Missing witness:":
        return [Seg(s, AMBER, True)]
    if s.startswith("ORIGINAL") or s.startswith("EVIL TWIN"):
        match = re.match(r"^(ORIGINAL|EVIL TWIN)(\s+)(.*)$", s)
        if match:
            label, gap, rest = match.groups()
            label_color = TEXT if label == "ORIGINAL" else ACCENT
            tick = ""
            if rest.endswith("✓"):
                rest = rest[:-1].rstrip()
                tick = "  ✓"
            return [Seg(label, label_color, True), Seg(gap, TEXT), Seg(rest, GREEN), Seg(tick, GREEN)]
    return [Seg(text, TEXT)]


def build_rows(lines: list[str]) -> tuple[list[Row], dict[str, int]]:
    """Turn captured report lines into staged rows and remember key row indices."""
    triggers = [
        ("Your implementation:", 2),
        ("Evil Twin:", 3),
        ("ORIGINAL", 4),
        ("EVIL TWIN", 5),
        ("Your tests accept", 6),
        ("Missing witness:", 7),
    ]
    stages: list[int | None] = []
    current = 0
    twin_next = False
    twin_code = False
    rows: list[Row] = []
    index: dict[str, int] = {}

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            stages.append(None)
            rows.append(Row(0, [Seg("")]))
            twin_next = False
            continue
        for keyword, stage in triggers:
            if stripped.startswith(keyword):
                current = stage
                break
        if stripped == "Your implementation:":
            twin_next = False
        elif stripped == "Evil Twin:":
            twin_next = True
        twin_code = twin_next and not stripped.startswith("Evil Twin:")
        if stripped.startswith("ORIGINAL"):
            index["original"] = i
        if stripped.startswith("EVIL TWIN"):
            index["twin"] = i
        if stripped.startswith("Missing witness:") and i + 1 < len(lines):
            index["witness"] = i + 1
        stages.append(current)
        rows.append(Row(current, style_line(line, twin_code), prompt=stripped.startswith("$ ")))

    # Blank rows join the stage of the block that follows them (look ahead, top-down
    # reveal keeps every row on a fixed grid, so nothing ever shifts between frames).
    next_stage: int | None = None
    for i in range(len(stages) - 1, -1, -1):
        if stages[i] is None:
            stages[i] = next_stage if next_stage is not None else 0
        else:
            next_stage = stages[i]
    for row, stage in zip(rows, stages):
        row.stage = stage or 0
    return rows, index


def draw_terminal(
    rows: list[Row],
    panels: list[dict],
    stage: int,
    typed: str | None,
    pulse: bool,
    scale: int = 1,
) -> Image.Image:
    font_size = 24 * scale
    line_h = 36 * scale
    pad_x = 44 * scale
    pad_y = 32 * scale
    longest = max(sum(seg_width(seg, font_size) for seg in row.segs) for row in rows)
    width = pad_x * 2 + math.ceil(longest)
    height = pad_y * 2 + line_h * len(rows)

    img = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width - 1, height - 1], outline=BORDER, width=max(1, scale))

    for panel in panels:
        if stage < panel["stage"]:
            continue
        first, last = panel["rows"]
        fill = panel["fill"]
        if pulse and panel.get("hot"):
            fill = panel["hot"]
        x0 = pad_x - 16 * scale
        x1 = width - pad_x + 16 * scale
        y0 = pad_y + first * line_h + 3 * scale
        y1 = pad_y + (last + 1) * line_h - 3 * scale
        d.rounded_rectangle([x0, y0, x1, y1], radius=8 * scale, fill=fill)

    mono = mono_font(font_size)
    for i, row in enumerate(rows):
        if row.stage > stage:
            continue
        segs = row.segs
        if row.prompt and typed is not None:
            segs = [Seg("$ ", GREEN, True), Seg(typed, TEXT)]
        y_text = pad_y + i * line_h + (line_h - (mono.getmetrics()[0] + mono.getmetrics()[1])) // 2
        draw_segs(d, pad_x, y_text, segs, font_size)

    if typed is not None and rows[0].stage <= stage:
        prompt_row = next((i for i, r in enumerate(rows) if r.prompt), None)
        if prompt_row is not None and rows[prompt_row].stage <= stage:
            cursor_x = pad_x + mono.getlength("$ " + typed) + 2 * scale
            cursor_h = round(font_size * 0.95)
            cursor_y = pad_y + prompt_row * line_h + (line_h - cursor_h) // 2
            d.rectangle(
                [cursor_x, cursor_y, cursor_x + max(2, round(font_size * 0.5)), cursor_y + cursor_h],
                fill=TEXT,
            )
    return img


# --------------------------------------------------------------------------------------
# Hero GIF + hero PNG
# --------------------------------------------------------------------------------------

def write_hero(raw: str) -> tuple[Path, Path]:
    expect(
        raw,
        "$ testslop twin",
        "ORIGINAL    3 / 3 tests passed  ✓",
        "EVIL TWIN   3 / 3 tests passed  ✓",
        "Your tests accept BOTH implementations.",
        "quantity = 1",
    )
    lines = clean_report(raw, drop_location=True)
    rows, index = build_rows(lines)
    if len(rows) != 17:
        raise RuntimeError(f"hero report has an unexpected shape ({len(rows)} rows)")

    prompt_row = next(i for i, r in enumerate(rows) if r.prompt)
    command = lines[prompt_row].strip()[2:]
    panels = [
        {"stage": 5, "rows": [index["original"], index["twin"]], "fill": PANEL},
        {"stage": 7, "rows": [index["witness"], index["witness"]], "fill": AMBER_PANEL, "hot": AMBER_PANEL_HOT},
    ]

    frames: list[Image.Image] = []
    durations: list[int] = []

    def add(stage: int, ms: int, typed: str | None = None, pulse: bool = False) -> None:
        frames.append(draw_terminal(rows, panels, stage, typed, pulse))
        durations.append(ms)

    add(0, 400, typed="")  # prompt line with a resting cursor
    for i in range(1, len(command) + 1):
        add(0, 55, typed=command[:i])
    add(0, 450, typed=command)
    add(2, 750)
    add(3, 750)
    add(4, 350)
    add(5, 900)
    add(6, 1000)
    add(7, 1400)
    add(7, 600, pulse=True)
    add(7, 1300)

    gif_dir = ASSETS / "hero"
    gif_dir.mkdir(parents=True, exist_ok=True)
    gif_path = gif_dir / "testslop-hero.gif"

    palette_source = frames[-1].quantize(colors=64)
    quantized = [frame.quantize(palette=palette_source, dither=Image.Dither.NONE) for frame in frames]
    quantized[0].save(
        gif_path,
        save_all=True,
        append_images=quantized[1:],
        duration=durations,
        loop=0,
        optimize=True,
    )

    png_path = gif_dir / "testslop-hero.png"
    draw_terminal(rows, panels, 7, None, False, scale=2).save(png_path, optimize=True)
    return gif_path, png_path


# --------------------------------------------------------------------------------------
# Historical vercel/ms screenshot
# --------------------------------------------------------------------------------------

def write_ms(raw: str) -> Path:
    expect(
        raw,
        "msAbs >= y",
        "msAbs > y",
        "ORIGINAL    163 / 163 tests passed  ✓",
        "EVIL TWIN   163 / 163 tests passed  ✓",
        "ms = 31,557,600,000 ms",
    )
    scale = 2
    lines = clean_report(raw, drop_location=False)
    rows, index = build_rows(["$ npm run demo:history", ""] + lines)
    panels = [
        {"stage": 0, "rows": [index["original"], index["twin"]], "fill": PANEL},
        {"stage": 0, "rows": [index["witness"], index["witness"]], "fill": AMBER_PANEL},
    ]

    font_size = 24 * scale
    line_h = 36 * scale
    pad = 44 * scale
    mono = mono_font(font_size)

    caption = "vercel/ms — replay of the commit that added month formatting"
    caption_font = sans_font(20 * scale)
    footer_prefix = "At exactly one year the output changes:"
    footer_value = "  1y → 12mo"
    footer_sans = sans_font(19 * scale)
    footer_mono = mono_font(19 * scale)

    body_w = math.ceil(max(sum(seg_width(seg, font_size) for seg in row.segs) for row in rows))
    caption_w = math.ceil(caption_font.getlength(caption))
    footer_w = math.ceil(
        footer_sans.getlength(footer_prefix) + footer_mono.getlength(footer_value)
    )
    width = pad * 2 + max(body_w, caption_w, footer_w)

    caption_size = 20 * scale
    caption_h = caption_size + 16 * scale
    body_h = line_h * len(rows)
    footer_gap = 20 * scale
    footer_h = 19 * scale + 8 * scale
    height = 40 * scale + caption_h + body_h + footer_gap + 1 + footer_gap + footer_h + 36 * scale

    img = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width - 1, height - 1], outline=BORDER, width=scale)

    y = 40 * scale
    d.text((pad, y), caption, font=caption_font, fill=DIM)
    y += caption_h

    body_top = y
    for panel in panels:
        first, last = panel["rows"]
        x0 = pad - 16 * scale
        x1 = width - pad + 16 * scale
        py0 = body_top + first * line_h + 3 * scale
        py1 = body_top + (last + 1) * line_h - 3 * scale
        d.rounded_rectangle([x0, py0, x1, py1], radius=8 * scale, fill=panel["fill"])

    for i, row in enumerate(rows):
        y_text = body_top + i * line_h + (line_h - (mono.getmetrics()[0] + mono.getmetrics()[1])) // 2
        draw_segs(d, pad, y_text, row.segs, font_size)
    y = body_top + body_h + footer_gap

    d.line([(pad, y), (width - pad, y)], fill=BORDER, width=scale)
    y += footer_gap
    d.text((pad, y), footer_prefix, font=footer_sans, fill=DIM)
    fx = pad + footer_sans.getlength(footer_prefix)
    d.text(
        (fx, y + (footer_sans.getmetrics()[0] - footer_mono.getmetrics()[0]) // 2),
        footer_value,
        font=footer_mono,
        fill=AMBER,
        stroke_width=1,
        stroke_fill=AMBER,
    )

    out = ASSETS / "screenshots" / "ms-historical-example.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)
    return out


# --------------------------------------------------------------------------------------
# "How it works" concept diagram
# --------------------------------------------------------------------------------------

DIAGRAM_BOXES = [
    ("Agent changes code", None),
    ("Tests pass", GREEN),
    ("TestSlop creates an Evil Twin", ACCENT),
    ("Runs the same tests", None),
    ("Both pass", GREEN),
    ("Shows the missing witness", AMBER),
]


def diagram_geometry() -> tuple[int, int, int, int, int, int]:
    box_w, box_h, gap, pad = 380, 56, 36, 40
    width = box_w + pad * 2
    height = box_h * len(DIAGRAM_BOXES) + gap * (len(DIAGRAM_BOXES) - 1) + pad * 2
    return width, height, box_w, box_h, gap, pad


def draw_arrow(d: ImageDraw.ImageDraw, x: int, y0: int, y1: int, scale: int, color: str = DIM) -> None:
    head = 5 * scale
    d.line([(x, y0), (x, y1 - head * 2)], fill=color, width=2 * scale)
    d.polygon([(x, y1), (x - head, y1 - head * 2), (x + head, y1 - head * 2)], fill=color)


def write_diagram() -> tuple[Path, Path]:
    out_dir = ASSETS / "diagrams"
    out_dir.mkdir(parents=True, exist_ok=True)

    scale = 2
    width, height, box_w, box_h, gap, pad = diagram_geometry()
    w, h = width * scale, height * scale
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w - 1, h - 1], outline=BORDER, width=scale)

    cx = w // 2
    for i, (label, accent) in enumerate(DIAGRAM_BOXES):
        top = (pad + i * (box_h + gap)) * scale
        box = [cx - (box_w // 2) * scale, top, cx + (box_w // 2) * scale, top + box_h * scale]
        d.rounded_rectangle(
            box,
            radius=10 * scale,
            fill=PANEL,
            outline=accent or BORDER,
            width=max(1, (2 if accent else 1) * scale),
        )
        font = sans_font(21 * scale, bold=True)
        fill = accent or TEXT
        tw = font.getlength(label)
        asc, desc = font.getmetrics()
        d.text(
            (cx - tw / 2, top + (box_h * scale - (asc + desc)) / 2),
            label,
            font=font,
            fill=fill,
        )
        if i < len(DIAGRAM_BOXES) - 1:
            draw_arrow(d, cx, top + box_h * scale + 4 * scale, top + (box_h + gap) * scale - 2 * scale, scale)

    png = out_dir / "how-it-works.png"
    img.save(png, optimize=True)

    svg_lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-label="How TestSlop works: an agent changes code, '
        'tests pass, TestSlop creates an Evil Twin and runs the same tests, both pass, '
        'and the missing witness is shown.">',
        f'<rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" fill="{BG}" stroke="{BORDER}"/>',
    ]
    font_stack = "'Segoe UI', -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif"
    for i, (label, accent) in enumerate(DIAGRAM_BOXES):
        top = pad + i * (box_h + gap)
        stroke = accent or BORDER
        stroke_w = 2 if accent else 1
        svg_lines.append(
            f'<rect x="{(width - box_w) // 2}" y="{top}" width="{box_w}" height="{box_h}" rx="10" '
            f'fill="{PANEL}" stroke="{stroke}" stroke-width="{stroke_w}"/>'
        )
        svg_lines.append(
            f'<text x="{width // 2}" y="{top + box_h // 2}" fill="{accent or TEXT}" font-family="{font_stack}" '
            f'font-size="21" font-weight="600" text-anchor="middle" dominant-baseline="central">{label}</text>'
        )
        if i < len(DIAGRAM_BOXES) - 1:
            x = width // 2
            y0 = top + box_h + 4
            y1 = top + box_h + gap - 2
            head = 5
            svg_lines.append(f'<line x1="{x}" y1="{y0}" x2="{x}" y2="{y1 - head * 2}" stroke="{DIM}" stroke-width="2"/>')
            svg_lines.append(
                f'<polygon points="{x},{y1} {x - head},{y1 - head * 2} {x + head},{y1 - head * 2}" fill="{DIM}"/>'
            )
    svg_lines.append("</svg>")

    svg = out_dir / "how-it-works.svg"
    svg.write_text("\n".join(svg_lines) + "\n", encoding="utf-8")
    return png, svg


# --------------------------------------------------------------------------------------
# Social share card (1200x630) from the real ms replay
# --------------------------------------------------------------------------------------

def write_social(raw: str) -> Path:
    match_o = re.search(r"ORIGINAL\s+(\d+) / (\d+) tests passed", raw)
    match_w = re.search(r"(Missing witness:\s*\n\s*)(.+)", raw)
    if not match_o or not match_w:
        raise RuntimeError("could not parse the ms replay report for the share card")
    passed, total = match_o.group(1), match_o.group(2)
    witness = match_w.group(2).strip()

    width, height = 1200, 630
    img = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, width - 1, height - 1], outline=BORDER, width=2)

    title_font = sans_font(40, bold=True)
    tagline_font = sans_font(24)
    d.text((56, 44), "TestSlop", font=title_font, fill=TEXT)
    d.text((56, 100), "Your tests pass. So does the wrong code.",
           font=tagline_font, fill=DIM)

    font_size = 32
    line_h = 44
    x = 56
    y = 196
    mono = mono_font(font_size)
    rows: list[list[Seg]] = [
        [Seg("ORIGINAL", TEXT, True), Seg("    "), Seg(f"{passed} / {total} tests passed", GREEN), Seg("  ✓", GREEN)],
        [Seg("EVIL TWIN", ACCENT, True), Seg("   "), Seg(f"{passed} / {total} tests passed", GREEN), Seg("  ✓", GREEN)],
        [Seg("")],
        [Seg("Your tests accept ", TEXT, True), Seg("BOTH", ACCENT, True), Seg(" implementations.", TEXT, True)],
        [Seg("")],
        [Seg("Missing witness:", AMBER, True)],
        [Seg(witness, AMBER)],
    ]
    # Symmetry panel behind the two count rows, witness panel behind the last two rows.
    d.rounded_rectangle([x - 16, y + 3, width - 56, y + line_h * 2 - 3], radius=8, fill=PANEL)
    d.rounded_rectangle(
        [x - 16, y + line_h * 5 + 3, width - 56, y + line_h * 7 - 3], radius=8, fill=AMBER_PANEL
    )
    for i, segs in enumerate(rows):
        y_text = y + i * line_h + (line_h - (mono.getmetrics()[0] + mono.getmetrics()[1])) // 2
        draw_segs(d, x, y_text, segs, font_size)

    foot_font = sans_font(18)
    d.text(
        (56, height - 46),
        f"vercel/ms historical replay — {passed} / {total} tests pass both ways",
        font=foot_font,
        fill=DIM,
    )

    out = ASSETS / "social" / "testslop-share.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)
    return out


# --------------------------------------------------------------------------------------
# Optional MP4 of the hero frames
# --------------------------------------------------------------------------------------

def write_mp4(gif_path: Path) -> Path | None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("ffmpeg not found — skipping testslop-hero.mp4")
        return None
    with Image.open(gif_path) as gif:
        frames = []
        durations = []
        try:
            index = 0
            while True:
                gif.seek(index)
                frames.append(gif.convert("RGB").copy())
                durations.append(gif.info.get("duration", 100))
                index += 1
        except EOFError:
            pass

    fps = 20
    out = ASSETS / "social" / "testslop-hero.mp4"
    with tempfile.TemporaryDirectory(prefix="testslop-mp4-") as tmp:
        tmp_dir = Path(tmp)
        n = 0
        for frame, duration in zip(frames, durations):
            repeats = max(1, round(duration / 1000 * fps))
            for _ in range(repeats):
                frame.save(tmp_dir / f"frame_{n:04d}.png")
                n += 1
        cmd = [
            ffmpeg, "-y", "-framerate", str(fps), "-i", str(tmp_dir / "frame_%04d.png"),
            "-c:v", "libx264", "-preset", "slow", "-crf", "24",
            "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(out),
        ]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            print("ffmpeg failed — skipping MP4\n" + result.stderr.decode("utf-8", "replace")[-1500:])
            return None
    return out


def main() -> None:
    print("running the real hero demo…")
    hero_raw = run_node("hero-demo.mjs")
    print("running the real vercel/ms replay…")
    ms_raw = run_node("replay-ms-history.mjs")

    outputs = []
    outputs += write_hero(hero_raw)
    outputs.append(write_ms(ms_raw))
    outputs += write_diagram()
    outputs.append(write_social(ms_raw))

    gif = ASSETS / "hero" / "testslop-hero.gif"
    outputs.append(write_mp4(gif))

    print("\nassets:")
    for path in outputs:
        if path is None:
            continue
        print(f"  {path.relative_to(ROOT)}  ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
