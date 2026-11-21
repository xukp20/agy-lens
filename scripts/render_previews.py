#!/usr/bin/env python3
"""
High-craft 2x Retina UI preview renderer for AGY Lens README & documentation.
Uses pure Python + cairosvg + Pillow with exact CSS color tokens from
sidecars/lens_panel/web/styles.css and anonymized synthetic metrics matching
scripts/demo_server.mjs.

Outputs 5 PNGs into assets/screenshots/:
  - hero-dual-theme.png
  - cache-observatory.png
  - cost-calendar.png
  - quota-budget.png
  - settings-drawer.png
"""

from __future__ import annotations

import html
import math
import random
import re
from pathlib import Path
from typing import Any

import cairosvg
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT_DIR = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT_DIR / "assets" / "screenshots"
LOGO_PATH = ROOT_DIR / "assets" / "logo.svg"

FONT_UI = "DejaVu Sans, sans-serif"
FONT_MONO = "DejaVu Sans Mono, monospace"
FONT_CJK = "Droid Sans Fallback, DejaVu Sans, sans-serif"

_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}
_FONT_PATHS = {
    (False, False): "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    (True, False): "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    (False, True): "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    (True, True): "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
}


def text_w(text: str, font_size: float, bold: bool = False, mono: bool = False) -> float:
    """Measure exact rendered pixel width using the system TTF font."""
    key = (f"{bold}:{mono}", int(round(font_size * 10)))
    font = _FONT_CACHE.get(key)
    if font is None:
        path = _FONT_PATHS[(bold, mono)]
        if not Path(path).exists():
            path = _FONT_PATHS[(False, mono)]
        font = ImageFont.truetype(path, size=max(6, int(round(font_size * 10))))
        _FONT_CACHE[key] = font
    return font.getlength(text) / 10.0

# Exact host-synced theme tokens mirroring sidecars/lens_panel/web/styles.css
# and scripts/demo_server.mjs.
DARK: dict[str, Any] = {
    "name": "dark",
    "bg": "#18191c",
    "header_bg": "#1a1b1f",
    "surface": "#202227",
    "secondary": "#2a2d34",
    "muted": "#24262c",
    "field": "#292b32",
    "fill": "#272930",
    "fg": "#eceef2",
    "fg2": "#c8ccd4",
    "fg_muted": "#8f96a3",
    "fg_faint": "#646b78",
    "border": "#30333b",
    "card_border": "#343842",
    "line": "#2d3039",
    "accent": "#5b9cf6",
    "accent_fg": "#ffffff",
    "accent_bg": "#233248",
    "accent_border": "#37557f",
    "ok": "#5ab870",
    "ok_bg": "#203328",
    "ok_border": "#2f573d",
    "warn": "#dfb044",
    "warn_bg": "#352e20",
    "bad": "#e36868",
    "bad_bg": "#382226",
    "ch_cache": "#4eb88e",
    "ch_uncached": "#659be0",
    "ch_think": "#9d82e3",
    "ch_visible": "#df9c3e",
    "ctx": ["#659be0", "#9d82e3", "#4eb88e", "#6cb5c7", "#df9c3e"],
    "hm": ["#2c2f37", "#2c4c43", "#37725d", "#439677", "#4eb88e"],
    "heat_deep_bg": "#243b2f",
    "heat_soft_bg": "#223634",
    "heat_amber_bg": "#362f21",
    "heat_coral_bg": "#3a2326",
}

LIGHT: dict[str, Any] = {
    "name": "light",
    "bg": "#f7f7f8",
    "header_bg": "#f8f8fa",
    "surface": "#ffffff",
    "secondary": "#e6e7e9",
    "muted": "#eff0f1",
    "field": "#f1f2f4",
    "fill": "#eceef0",
    "fg": "#1d1f21",
    "fg2": "#3d4348",
    "fg_muted": "#5d676f",
    "fg_faint": "#9098a0",
    "border": "#e1e3e6",
    "card_border": "#dcdfe3",
    "line": "#e9ebee",
    "accent": "#1a73e8",
    "accent_fg": "#ffffff",
    "accent_bg": "#e4effd",
    "accent_border": "#adcaf7",
    "ok": "#2e8540",
    "ok_bg": "#e6f2e8",
    "ok_border": "#b5dab9",
    "warn": "#b47d14",
    "warn_bg": "#f7efe0",
    "bad": "#c93b3b",
    "bad_bg": "#fae8e8",
    "ch_cache": "#2a8c68",
    "ch_uncached": "#3b78c2",
    "ch_think": "#7a5ec4",
    "ch_visible": "#c98324",
    "ctx": ["#3b78c2", "#7a5ec4", "#2a8c68", "#4d97a6", "#c98324"],
    "hm": ["#eaeced", "#c4e4d6", "#8cc9b0", "#54aa8a", "#2a8c68"],
    "heat_deep_bg": "#e2f3e6",
    "heat_soft_bg": "#e3f2ec",
    "heat_amber_bg": "#f8efdb",
    "heat_coral_bg": "#fbe5e5",
}


def esc(text: Any) -> str:
    return html.escape(str(text), quote=True)


def extract_logo_inner(uid: str) -> str:
    """Inline logo.svg geometry with unique gradient IDs for crisp vector scaling."""
    raw = LOGO_PATH.read_text(encoding="utf-8")
    inner = re.sub(r"^<svg[^>]*>\s*", "", raw.strip())
    inner = re.sub(r"\s*</svg>$", "", inner)
    for gid in ["prismBg", "prismEdge", "lensRing", "pulseStroke", "apertureGlow"]:
        inner = inner.replace(f'id="{gid}"', f'id="{gid}_{uid}"')
        inner = inner.replace(f"url(#{gid})", f"url(#{gid}_{uid})")
    return inner


def pill_width(label: str, font_size: float = 10.5, pad_x: float = 8.0, mono: bool = False) -> float:
    return text_w(label, font_size, bold=True, mono=mono) + pad_x * 2


def svg_pill(
    x: float,
    y: float,
    label: str,
    bg: str,
    fg: str,
    border: str | None = None,
    font_size: float = 10.5,
    h: float = 20.0,
    pad_x: float = 8.0,
    mono: bool = False,
) -> tuple[str, float]:
    w = pill_width(label, font_size=font_size, pad_x=pad_x, mono=mono)
    stroke_attr = f' stroke="{border}" stroke-width="1"' if border else ""
    ff = FONT_MONO if mono else FONT_UI
    svg = (
        f'<g>'
        f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{h/2:.1f}" fill="{bg}"{stroke_attr}/>'
        f'<text x="{x + w/2:.1f}" y="{y + h*0.67:.1f}" text-anchor="middle" '
        f'font-family="{ff}" font-size="{font_size}" font-weight="600" fill="{fg}">{esc(label)}</text>'
        f"</g>"
    )
    return svg, w


def svg_help_dot(cx: float, cy: float, th: dict[str, Any], active: bool = False) -> str:
    bg = th["accent_bg"] if active else "none"
    stroke = th["accent"] if active else th["fg_faint"]
    fg = th["accent"] if active else th["fg_muted"]
    return (
        f'<g>'
        f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="7" fill="{bg}" stroke="{stroke}" stroke-width="1"/>'
        f'<text x="{cx:.1f}" y="{cy + 3.4:.1f}" text-anchor="middle" '
        f'font-family="{FONT_UI}" font-size="9.5" font-weight="700" fill="{fg}">?</text>'
        f"</g>"
    )


def svg_chevron(cx: float, cy: float, color: str, up: bool = True) -> str:
    if up:
        d = f"M {cx-4:.1f} {cy+2:.1f} L {cx:.1f} {cy-2:.1f} L {cx+4:.1f} {cy+2:.1f}"
    else:
        d = f"M {cx-4:.1f} {cy-2:.1f} L {cx:.1f} {cy+2:.1f} L {cx+4:.1f} {cy-2:.1f}"
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'


def svg_gear(x: float, y: float, size: float, color: str) -> str:
    s = size / 24.0
    return (
        f'<g transform="translate({x:.1f},{y:.1f}) scale({s:.4f})">'
        f'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" '
        f'fill="none" stroke="{color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
        f'<circle cx="12" cy="12" r="3" fill="none" stroke="{color}" stroke-width="1.8"/>'
        f"</g>"
    )


def svg_refresh(x: float, y: float, size: float, color: str) -> str:
    s = size / 16.0
    return (
        f'<g transform="translate({x:.1f},{y:.1f}) scale({s:.4f})">'
        f'<path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.65M13.5 2.5v2.75h-2.75" '
        f'fill="none" stroke="{color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
        f"</g>"
    )


def svg_switch(x: float, y: float, on: bool, th: dict[str, Any]) -> str:
    track = th["accent"] if on else th["fg_faint"]
    knob_x = x + 18 if on else x + 6
    return (
        f'<g>'
        f'<rect x="{x:.1f}" y="{y:.1f}" width="26" height="14" rx="7" fill="{track}"/>'
        f'<circle cx="{knob_x:.1f}" cy="{y + 7:.1f}" r="5" fill="#ffffff"/>'
        f"</g>"
    )


def make_stage_background(w: int, h: int, top_rgb: tuple[int, int, int], bot_rgb: tuple[int, int, int]) -> Image.Image:
    """Create a smooth vertical studio gradient backdrop with subtle ambient glow."""
    bg = Image.new("RGBA", (w, h))
    px = bg.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top_rgb[0] * (1 - t) + bot_rgb[0] * t)
        g = int(top_rgb[1] * (1 - t) + bot_rgb[1] * t)
        b = int(top_rgb[2] * (1 - t) + bot_rgb[2] * t)
        for x in range(w):
            px[x, y] = (r, g, b, 255)

    # Subtle radial glow behind top-center
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((int(w * 0.12), int(-h * 0.25), int(w * 0.88), int(h * 0.65)), fill=(91, 156, 246, 22))
    gd.ellipse((int(w * 0.48), int(h * 0.15), int(w * 1.05), int(h * 0.95)), fill=(78, 184, 142, 16))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=int(min(w, h) * 0.14)))
    return Image.alpha_composite(bg, glow)


def round_and_shadow(
    fg_img: Image.Image,
    radius: int,
    shadow_blur: int = 28,
    shadow_offset_y: int = 16,
    shadow_alpha: int = 125,
) -> tuple[Image.Image, Image.Image]:
    """Return (rounded_panel_rgba, soft_shadow_rgba) with matching dimensions."""
    pw, ph = fg_img.size
    mask = Image.new("L", (pw, ph), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, pw - 1, ph - 1), radius=radius, fill=255)

    panel = fg_img.convert("RGBA")
    panel.putalpha(mask)

    pad = shadow_blur * 2
    sh = Image.new("RGBA", (pw + pad * 2, ph + pad * 2), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle(
        (pad, pad + shadow_offset_y, pad + pw - 1, pad + ph - 1 + shadow_offset_y),
        radius=radius,
        fill=(6, 8, 13, shadow_alpha),
    )
    sh = sh.filter(ImageFilter.GaussianBlur(radius=shadow_blur))
    return panel, sh


def rasterize_svg(svg_str: str, scale: int = 2) -> Image.Image:
    from io import BytesIO

    png_bytes = cairosvg.svg2png(bytestring=svg_str.encode("utf-8"), scale=scale)
    return Image.open(BytesIO(png_bytes)).convert("RGBA")


def composite_panels(
    stage_w: int,
    stage_h: int,
    placements: list[tuple[str, int, int, int]],
    scale: int = 2,
    top_rgb: tuple[int, int, int] = (14, 17, 24),
    bot_rgb: tuple[int, int, int] = (10, 12, 18),
    header_svg: str | None = None,
) -> Image.Image:
    """Composite one or more SVG panels with crisp 2x shadows onto a Retina stage."""
    W = stage_w * scale
    H = stage_h * scale
    canvas = make_stage_background(W, H, top_rgb, bot_rgb)

    if header_svg:
        hdr = rasterize_svg(header_svg, scale=scale)
        canvas.alpha_composite(hdr, (0, 0))

    blur = 22 * scale
    pad = blur * 2
    for svg_str, lx, ly, radius in placements:
        panel_img = rasterize_svg(svg_str, scale=scale)
        panel, sh = round_and_shadow(
            panel_img,
            radius=radius * scale,
            shadow_blur=blur,
            shadow_offset_y=12 * scale,
            shadow_alpha=120,
        )
        px = lx * scale
        py = ly * scale
        canvas.alpha_composite(sh, (px - pad, py - pad))
        canvas.alpha_composite(panel, (px, py))

    return canvas.convert("RGB")


# ---------------------------------------------------------------------------
# 1. Hero Dual Theme (Dark + Light Aux Panes side-by-side)
# ---------------------------------------------------------------------------
def build_aux_pane_svg(th: dict[str, Any], uid: str) -> str:
    W, H = 490, 712
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        f'<rect width="{W}" height="{H}" fill="{th["bg"]}"/>',
    ]

    # Sticky Header
    parts.append(f'<rect x="0" y="0" width="{W}" height="78" fill="{th["header_bg"]}"/>')
    parts.append(f'<line x1="0" y1="78" x2="{W}" y2="78" stroke="{th["border"]}" stroke-width="1"/>')

    # Logo + title
    logo_inner = extract_logo_inner(uid)
    parts.append(f'<g transform="translate(14,11) scale(0.156)">{logo_inner}</g>')
    parts.append(
        f'<text x="41" y="25.5" font-family="{FONT_UI}" font-size="14" font-weight="700" fill="{th["fg"]}">AGY Lens</text>'
    )
    # Right header controls
    parts.append(f'<circle cx="332" cy="21" r="3.2" fill="{th["ok"]}"/>')
    parts.append(
        f'<text x="340" y="24.5" font-family="{FONT_MONO}" font-size="10.5" fill="{th["fg_muted"]}">Live</text>'
    )
    parts.append(
        f'<text x="377" y="24.5" font-family="{FONT_MONO}" font-size="10.5" fill="{th["fg_muted"]}">30s ▾</text>'
    )
    parts.append(svg_refresh(422, 13, 15, th["fg_muted"]))
    parts.append(svg_gear(454, 13, 15, th["fg_muted"]))

    # Range Bar
    ranges = ["Today", "5h", "7d", "30d", "90d", "All", "Custom"]
    rx = 14.0
    for r in ranges:
        rw = len(r) * 6.4 + 14
        active = r == "7d"
        rbg = th["accent_bg"] if active else th["fill"]
        rfg = th["accent"] if active else th["fg_muted"]
        rstroke = f' stroke="{th["accent_border"]}" stroke-width="1"' if active else ""
        parts.append(
            f'<rect x="{rx:.1f}" y="44" width="{rw:.1f}" height="22" rx="11" fill="{rbg}"{rstroke}/>'
        )
        parts.append(
            f'<text x="{rx + rw/2:.1f}" y="58.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" font-weight="600" fill="{rfg}">{r}</text>'
        )
        rx += rw + 5

    # Source pill
    src_lbl = "Desktop + CLI"
    sw = 86
    parts.append(
        f'<rect x="{W - 14 - sw}" y="44" width="{sw}" height="22" rx="11" fill="{th["surface"]}" stroke="{th["border"]}" stroke-width="1"/>'
    )
    parts.append(
        f'<text x="{W - 14 - sw/2}" y="58.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" font-weight="500" fill="{th["fg_muted"]}">{src_lbl}</text>'
    )

    # ---- Card 1: Live Context ----
    c1_y, c1_h = 90, 246
    cx, cw = 12, W - 24
    parts.append(
        f'<rect x="{cx}" y="{c1_y}" width="{cw}" height="{c1_h}" rx="10" fill="{th["surface"]}" stroke="{th["card_border"]}" stroke-width="1"/>'
    )
    c1_title = "Live Context"
    parts.append(f'<text x="24" y="{c1_y + 22}" font-family="{FONT_UI}" font-size="13" font-weight="700" fill="{th["fg"]}">{c1_title}</text>')
    q1_x = 24 + text_w(c1_title, 13, bold=True) + 12
    parts.append(svg_help_dot(q1_x, c1_y + 17.5, th))
    p_model, mw = svg_pill(q1_x + 13, c1_y + 8, "Gemini 4 Neon (High)", th["fill"], th["fg2"], font_size=10, h=19, pad_x=7)
    parts.append(p_model)
    p_pct, pw = svg_pill(W - 44 - 52, c1_y + 8, "47.4%", th["ok_bg"], th["ok"], font_size=10, h=19, pad_x=7, mono=True)
    parts.append(p_pct)
    parts.append(svg_chevron(W - 27, c1_y + 17.5, th["fg_muted"], up=True))

    # Numbers row
    parts.append(
        f'<text x="24" y="{c1_y + 46}" font-family="{FONT_MONO}" font-size="12.5" font-weight="700" fill="{th["fg"]}">242.8k</text>'
    )
    parts.append(
        f'<text x="{24 + text_w("242.8k", 12.5, bold=True, mono=True) + 3:.1f}" y="{c1_y + 46}" font-family="{FONT_MONO}" font-size="12" fill="{th["fg_muted"]}">/ 512.0k</text>'
    )
    parts.append(
        f'<text x="{W - 24}" y="{c1_y + 46}" text-anchor="end" font-family="{FONT_MONO}" font-size="10.5" fill="{th["fg_muted"]}">Turns: 26 · Dur: 3m44s</text>'
    )

    # Progress bar with 55% and 80% ticks
    tx, ty, tw, th_bar = 24, c1_y + 54, cw - 24, 8
    parts.append(f'<rect x="{tx}" y="{ty}" width="{tw}" height="{th_bar}" rx="4" fill="{th["fill"]}"/>')
    parts.append(f'<rect x="{tx}" y="{ty}" width="{tw * 0.474:.1f}" height="{th_bar}" rx="4" fill="{th["ok"]}"/>')
    parts.append(f'<line x1="{tx + tw * 0.55:.1f}" y1="{ty - 1}" x2="{tx + tw * 0.55:.1f}" y2="{ty + th_bar + 1}" stroke="{th["fg_muted"]}" stroke-width="1.5"/>')
    parts.append(f'<line x1="{tx + tw * 0.80:.1f}" y1="{ty - 1}" x2="{tx + tw * 0.80:.1f}" y2="{ty + th_bar + 1}" stroke="{th["warn"]}" stroke-width="1.5"/>')
    parts.append(f'<text x="{tx}" y="{ty + 20}" font-family="{FONT_UI}" font-size="10" fill="{th["fg_muted"]}">Auto-Compact ceiling · 55% / 80% markers</text>')

    # Divider + Stacked breakdown bar
    parts.append(f'<line x1="24" y1="{c1_y + 84}" x2="{W - 24}" y2="{c1_y + 84}" stroke="{th["line"]}" stroke-width="1"/>')
    bd_segs = [
        ("System Prompt", 14200, th["ctx"][0]),
        ("Tools", 28600, th["ctx"][1]),
        ("Rules", 9400, th["ctx"][2]),
        ("Skills", 6800, th["ctx"][3]),
        ("Chat Messages", 183800, th["ctx"][4]),
    ]
    tot_ctx = 242800.0
    sx = 24.0
    sy = c1_y + 95
    for _, tok, col in bd_segs:
        seg_w = max(4.0, (tok / tot_ctx) * tw - 1.5)
        parts.append(f'<rect x="{sx:.1f}" y="{sy}" width="{seg_w:.1f}" height="8" rx="2" fill="{col}"/>')
        sx += seg_w + 1.5

    ry = c1_y + 118
    for name, tok, col in bd_segs:
        pct = tok / tot_ctx * 100
        pct_str = f"({pct:.1f}%)"
        tok_str = f"{tok/1000:.1f}k"
        parts.append(f'<rect x="24" y="{ry - 8}" width="8" height="8" rx="2" fill="{col}"/>')
        parts.append(f'<text x="38" y="{ry}" font-family="{FONT_UI}" font-size="11.5" fill="{th["fg2"]}">{name}</text>')
        parts.append(f'<text x="{W - 24}" y="{ry}" text-anchor="end" font-family="{FONT_MONO}" font-size="11" fill="{th["fg_faint"]}">{pct_str}</text>')
        pct_w = text_w(pct_str, 11, mono=True)
        parts.append(f'<text x="{W - 24 - pct_w - 6:.1f}" y="{ry}" text-anchor="end" font-family="{FONT_MONO}" font-size="11" fill="{th["fg_muted"]}">{tok_str}</text>')
        ry += 23

    # ---- Card 2: Prompt Cache Diagnostics ----
    c2_y, c2_h = c1_y + c1_h + 10, 224
    parts.append(
        f'<rect x="{cx}" y="{c2_y}" width="{cw}" height="{c2_h}" rx="10" fill="{th["surface"]}" stroke="{th["card_border"]}" stroke-width="1"/>'
    )
    c2_title = "Prompt Cache Diagnostics"
    parts.append(f'<text x="24" y="{c2_y + 22}" font-family="{FONT_UI}" font-size="13" font-weight="700" fill="{th["fg"]}">{c2_title}</text>')
    parts.append(svg_help_dot(24 + text_w(c2_title, 13, bold=True) + 12, c2_y + 17.5, th))
    p_hit, _ = svg_pill(W - 96, c2_y + 8, "Hit 95%", th["ok_bg"], th["ok"], font_size=10, h=19, pad_x=8, mono=True)
    parts.append(p_hit)
    parts.append(svg_chevron(W - 27, c2_y + 17.5, th["fg_muted"], up=True))

    # 3 KPI tiles
    kpis = [
        ("Last Turn", "94.7%", "231.0k hit", th["fg"]),
        ("Session", "89.7%", "3.70M / 4.13M", th["fg"]),
        ("Saved", "$15.45", "vs uncached", th["ok"]),
    ]
    kw = (tw - 12) / 3
    for i, (lbl, val, sub, vcol) in enumerate(kpis):
        kx = 24 + i * (kw + 6)
        ky = c2_y + 36
        parts.append(f'<rect x="{kx:.1f}" y="{ky}" width="{kw:.1f}" height="48" rx="6" fill="{th["field"]}"/>')
        parts.append(f'<text x="{kx + 8:.1f}" y="{ky + 14}" font-family="{FONT_UI}" font-size="10" fill="{th["fg_muted"]}">{lbl}</text>')
        parts.append(f'<text x="{kx + 8:.1f}" y="{ky + 30}" font-family="{FONT_MONO}" font-size="13" font-weight="700" fill="{vcol}">{val}</text>')
        parts.append(f'<text x="{kx + 8:.1f}" y="{ky + 42}" font-family="{FONT_MONO}" font-size="9.5" fill="{th["fg_muted"]}">{sub}</text>')

    parts.append(f'<line x1="24" y1="{c2_y + 94}" x2="{W - 24}" y2="{c2_y + 94}" stroke="{th["line"]}" stroke-width="1"/>')
    parts.append(f'<text x="24" y="{c2_y + 111}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Last 15 turns input composition</text>')

    # Mini Legend
    leg_items = [("Cache Read", th["ch_cache"]), ("Uncached", th["ch_uncached"]), ("Cold", th["warn"]), ("Drop", th["bad"])]
    lx_cur = W - 24
    for lbl, col in reversed(leg_items):
        lw = len(lbl) * 5.6 + 14
        lx_cur -= lw
        parts.append(f'<rect x="{lx_cur:.1f}" y="{c2_y + 103}" width="7" height="7" rx="1.5" fill="{col}"/>')
        parts.append(f'<text x="{lx_cur + 10:.1f}" y="{c2_y + 110.5}" font-family="{FONT_UI}" font-size="9.5" fill="{th["fg_muted"]}">{lbl}</text>')

    # 15-turn stacked bar chart (from demo_server last 15 turns; step 28 is Cold amber, step 42 has slight drop marker)
    turn_bars = [
        (24, 137.9, 10.9, False, False),
        (26, 144.4, 11.5, False, False),
        (28, 0.0, 163.8, True, False),
        (30, 159.7, 12.0, False, False),
        (32, 174.8, 4.2, False, False),
        (34, 179.6, 7.8, False, False),
        (36, 188.8, 6.5, False, False),
        (38, 195.3, 7.5, False, False),
        (40, 205.5, 5.0, False, False),
        (42, 138.0, 79.6, False, True),
        (44, 209.2, 15.7, False, False),
        (46, 215.6, 16.4, False, False),
        (48, 228.9, 10.5, False, False),
        (50, 228.6, 15.4, False, False),
        (52, 231.0, 13.0, False, False),
    ]
    chart_x0, chart_y0, chart_w, chart_h = 24, c2_y + 124, tw, 76
    parts.append(f'<line x1="{chart_x0}" y1="{chart_y0 + chart_h}" x2="{chart_x0 + chart_w}" y2="{chart_y0 + chart_h}" stroke="{th["line"]}" stroke-width="1"/>')
    max_tot = 248.0
    slot_w = chart_w / len(turn_bars)
    bar_w = 18.0
    for idx, (step, cr, ui, is_cold, is_drop) in enumerate(turn_bars):
        bx = chart_x0 + idx * slot_w + (slot_w - bar_w) / 2
        cr_h = (cr / max_tot) * (chart_h - 8)
        ui_h = (ui / max_tot) * (chart_h - 8)
        y_cr = chart_y0 + chart_h - cr_h
        y_ui = y_cr - ui_h
        tot_h = cr_h + ui_h
        clip_id = f"cbclip_{uid}_{idx}"
        if tot_h > 0:
            parts.append(
                f'<defs><clipPath id="{clip_id}">'
                f'<rect x="{bx:.1f}" y="{y_ui:.1f}" width="{bar_w:.1f}" height="{tot_h:.1f}" rx="2.5" ry="2.5"/>'
                f'</clipPath></defs>'
            )
            parts.append(f'<g clip-path="url(#{clip_id})">')
            if cr_h > 0:
                parts.append(f'<rect x="{bx:.1f}" y="{y_cr:.1f}" width="{bar_w:.1f}" height="{cr_h:.1f}" fill="{th["ch_cache"]}"/>')
            if ui_h > 0:
                ucol = th["bad"] if is_drop else th["warn"] if is_cold else th["ch_uncached"]
                parts.append(f'<rect x="{bx:.1f}" y="{y_ui:.1f}" width="{bar_w:.1f}" height="{ui_h:.1f}" fill="{ucol}"/>')
            parts.append("</g>")
        if is_cold or is_drop:
            mcol = th["bad"] if is_drop else th["warn"]
            parts.append(f'<circle cx="{bx + bar_w/2:.1f}" cy="{max(chart_y0 + 3, y_ui - 5):.1f}" r="2.5" fill="{mcol}"/>')
        parts.append(f'<text x="{bx + bar_w/2:.1f}" y="{chart_y0 + chart_h + 13}" text-anchor="middle" font-family="{FONT_MONO}" font-size="8.5" fill="{th["fg_muted"]}">{step}</text>')

    # ---- Card 3: Input/Output & Token Flow ----
    c3_y, c3_h = c2_y + c2_h + 10, 124
    parts.append(
        f'<rect x="{cx}" y="{c3_y}" width="{cw}" height="{c3_h}" rx="10" fill="{th["surface"]}" stroke="{th["card_border"]}" stroke-width="1"/>'
    )
    c3_title = "Input/Output & Token Flow"
    parts.append(f'<text x="24" y="{c3_y + 22}" font-family="{FONT_UI}" font-size="13" font-weight="700" fill="{th["fg"]}">{esc(c3_title)}</text>')
    parts.append(svg_help_dot(24 + text_w(c3_title, 13, bold=True) + 12, c3_y + 17.5, th))

    # Session | Global seg
    parts.append(f'<rect x="{W - 144}" y="{c3_y + 7}" width="102" height="22" rx="6" fill="{th["fill"]}"/>')
    parts.append(f'<rect x="{W - 142}" y="{c3_y + 9}" width="50" height="18" rx="4" fill="{th["surface"]}"/>')
    parts.append(f'<text x="{W - 117}" y="{c3_y + 21.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="10" font-weight="600" fill="{th["fg"]}">Session</text>')
    parts.append(f'<text x="{W - 67}" y="{c3_y + 21.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="10" font-weight="500" fill="{th["fg_muted"]}">Global</text>')
    parts.append(svg_chevron(W - 27, c3_y + 17.5, th["fg_muted"], up=False))

    parts.append(f'<text x="24" y="{c3_y + 52}" font-family="{FONT_MONO}" font-size="17" font-weight="700" fill="{th["fg"]}">4.21M</text>')
    parts.append(f'<text x="{24 + text_w("4.21M", 17, bold=True, mono=True) + 6:.1f}" y="{c3_y + 52}" font-family="{FONT_UI}" font-size="11.5" fill="{th["fg_muted"]}">tokens</text>')
    parts.append(
        f'<text x="{W - 24}" y="{c3_y + 52}" text-anchor="end" font-family="{FONT_MONO}" font-size="11.5" fill="{th["fg_muted"]}">67.5M tok/hr · $3.99</text>'
    )

    # Proportional 4-segment flow bar
    io_segs = [
        ("Uncached", 425899, th["ch_uncached"], "425.9k"),
        ("Cache Read", 3701871, th["ch_cache"], "3.70M"),
        ("Thinking", 55288, th["ch_think"], "55.3k"),
        ("Visible", 28112, th["ch_visible"], "28.1k"),
    ]
    io_tot = sum(s[1] for s in io_segs)
    ix = 24.0
    iy = c3_y + 64
    for _, val, col, _ in io_segs:
        sw_seg = max(6.0, (val / io_tot) * tw - 1.5)
        parts.append(f'<rect x="{ix:.1f}" y="{iy}" width="{sw_seg:.1f}" height="9" rx="3" fill="{col}"/>')
        ix += sw_seg + 1.5

    lx = 24.0
    for lbl, _, col, short_v in io_segs:
        parts.append(f'<rect x="{lx:.1f}" y="{c3_y + 88}" width="8" height="8" rx="2" fill="{col}"/>')
        txt = f"{lbl} {short_v}"
        parts.append(f'<text x="{lx + 12:.1f}" y="{c3_y + 96}" font-family="{FONT_MONO}" font-size="10" fill="{th["fg_muted"]}">{txt}</text>')
        lx += len(txt) * 6.2 + 22

    parts.append("</svg>")
    return "\n".join(parts)


def render_hero_dual_theme() -> Path:
    W, H = 1200, 790
    hdr_svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="64" viewBox="0 0 {W} 64">'
        f'<text x="72" y="34" font-family="{FONT_MONO}" font-size="11" font-weight="600" fill="#8f96a3">DARK MODE · #18191c / #202227</text>'
        f'<text x="638" y="34" font-family="{FONT_MONO}" font-size="11" font-weight="600" fill="#8f96a3">LIGHT MODE · #f7f7f8 / #ffffff</text>'
        f'</svg>'
    )
    dark_svg = build_aux_pane_svg(DARK, "hero_dark")
    light_svg = build_aux_pane_svg(LIGHT, "hero_light")

    img = composite_panels(
        W,
        H,
        [(dark_svg, 72, 46, 14), (light_svg, 638, 46, 14)],
        scale=2,
        top_rgb=(17, 20, 29),
        bot_rgb=(11, 13, 19),
        header_svg=hdr_svg,
    )
    out = OUT_DIR / "hero-dual-theme.png"
    img.save(out, optimize=True)
    return out


# ---------------------------------------------------------------------------
# 2. Global Cache Observatory Showcase (v1.3.0 Dark Theme + Popover Callouts)
# ---------------------------------------------------------------------------
def build_cache_observatory_svg() -> str:
    th = DARK
    W, H = 1380, 774
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        f'<rect width="{W}" height="{H}" fill="{th["bg"]}"/>',
    ]

    # Left main Observatory card container
    cx, cy, cw, ch = 14, 14, 972, H - 28
    right_x = cx + cw
    parts.append(f'<rect x="{cx}" y="{cy}" width="{cw}" height="{ch}" rx="12" fill="{th["surface"]}" stroke="{th["card_border"]}" stroke-width="1"/>')

    # Card header
    obs_title = "Global Cache Observatory"
    parts.append(f'<text x="32" y="42" font-family="{FONT_UI}" font-size="14.5" font-weight="700" fill="{th["fg"]}">{obs_title}</text>')
    parts.append(svg_help_dot(32 + text_w(obs_title, 14.5, bold=True) + 12, 37.5, th))
    p_badge, _ = svg_pill(right_x - 148, 27, "64 0%-misses", th["bad_bg"], th["bad"], font_size=10.5, h=20, pad_x=9, mono=True)
    parts.append(p_badge)
    parts.append(svg_chevron(right_x - 24, 37.5, th["fg_muted"], up=True))

    # 4 KPI tiles
    kpis = [
        ("Follow-up Hit %", "85.6%", "1,420 follow-up turns", th["ok"]),
        ("Unexpected 0% Misses", "64", "48 bounce-backs", th["bad"]),
        ("Boundary Cuts", "11", "6 switch · 4 compact", th["warn"]),
        ("Miss Penalty", "$48.60", "9.84M wasted", th["bad"]),
    ]
    kw = (cw - 36 - 24) / 4
    for i, (lbl, val, sub, col) in enumerate(kpis):
        kx = 32 + i * (kw + 8)
        ky = 58
        parts.append(f'<rect x="{kx:.1f}" y="{ky}" width="{kw:.1f}" height="58" rx="7" fill="{th["field"]}"/>')
        parts.append(f'<text x="{kx + 12:.1f}" y="{ky + 18}" font-family="{FONT_UI}" font-size="11" fill="{th["fg_muted"]}">{lbl}</text>')
        parts.append(f'<text x="{kx + 12:.1f}" y="{ky + 38}" font-family="{FONT_MONO}" font-size="16" font-weight="700" fill="{col}">{val}</text>')
        parts.append(f'<text x="{kx + 12:.1f}" y="{ky + 51}" font-family="{FONT_MONO}" font-size="10" fill="{th["fg_muted"]}">{sub}</text>')

    parts.append(f'<line x1="32" y1="128" x2="{right_x - 18}" y2="128" stroke="{th["line"]}" stroke-width="1"/>')

    # Section 1: Model x Idle-Gap Configurable Metric Matrix
    parts.append(f'<text x="32" y="151" font-family="{FONT_UI}" font-size="12" font-weight="700" fill="{th["fg"]}">Model × Idle-Gap Matrix</text>')

    # Active Metric Trigger Pill ("Hit % +2 ▾")
    trig_w, trig_h = 88.0, 22.0
    trig_x = right_x - 18 - trig_w
    trig_y = 136.0
    parts.append(
        f'<rect x="{trig_x:.1f}" y="{trig_y:.1f}" width="{trig_w:.1f}" height="{trig_h:.1f}" rx="11" '
        f'fill="{th["accent_bg"]}" stroke="{th["accent"]}" stroke-width="1.2"/>'
    )
    parts.append(
        f'<text x="{trig_x + trig_w/2:.1f}" y="{trig_y + 14.8:.1f}" text-anchor="middle" '
        f'font-family="{FONT_UI}" font-size="10.5" font-weight="600" fill="{th["fg"]}">Hit % +2 ▾</text>'
    )

    # Legend line
    parts.append(
        f'<text x="32" y="168" font-family="{FONT_UI}" font-size="10.2" fill="{th["fg_muted"]}">'
        f'Primary: Token Hit Ratio · Sub: Keep % / $/turn · Hover preview / Click to pin</text>'
    )

    mx, my, mw = 32, 178, cw - 36
    hdr_h = 26
    row_h = 46
    cols = ["Model", "All", "<=2s", "2-5s", "5-10s", "10-20s", "20-60s", "1-5m", ">5m"]
    col_w = [208.0, 86.0] + [(mw - 294.0) / 7.0] * 7

    # Synthetic yet realistic curves mirroring real TTL decay & >5m cost surge
    # Each entry: (tokenHit%, keepRate%, avgCostStr) or None
    matrix_rows = [
        (
            "Gemini 4 Neon (High)",
            "412t · 28m",
            [
                (86, 90, "$0.26"),
                (96, 98, "$0.11"),
                (97, 99, "$0.10"),
                (98, 100, "$0.13"),
                (98, 100, "$0.14"),
                (97, 99, "$0.13"),
                (84, 88, "$0.31"),
                (22, 25, "$1.32"),
            ],
        ),
        (
            "Gemini 4 Hydrogen (High)",
            "586t · 14m",
            [
                (91, 95, "$0.04"),
                (93, 96, "$0.04"),
                (95, 97, "$0.03"),
                (92, 95, "$0.04"),
                (89, 93, "$0.05"),
                (88, 90, "$0.05"),
                (76, 88, "$0.04"),
                (12, 15, "$0.29"),
            ],
        ),
        (
            "Orchestrator (Carbon)",
            "316t · 22m",
            [
                (73, 77, "$0.13"),
                (87, 89, "$0.08"),
                (90, 91, "$0.06"),
                (89, 91, "$0.08"),
                (73, 79, "$0.15"),
                (71, 76, "$0.14"),
                (54, 61, "$0.17"),
                (17, 14, "$0.41"),
            ],
        ),
        (
            "Claude Opus 5.5 (High)",
            "106t",
            [
                (88, 93, "$0.12"),
                (87, 92, "$0.15"),
                (91, 97, "$0.09"),
                (93, 100, "$0.07"),
                (89, 95, "$0.09"),
                (81, 85, "$0.16"),
                (62, 68, "$0.24"),
                None,
            ],
        ),
    ]
    total_mh = hdr_h + len(matrix_rows) * row_h
    parts.append(f'<rect x="{mx}" y="{my}" width="{mw}" height="{total_mh}" rx="8" fill="{th["surface"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<rect x="{mx}" y="{my}" width="{mw}" height="{hdr_h}" rx="8" fill="{th["field"]}"/>')
    parts.append(f'<rect x="{mx}" y="{my + hdr_h - 6}" width="{mw}" height="6" fill="{th["field"]}"/>')

    # Header labels & vertical gridlines
    cx_cur = mx
    for idx, cname in enumerate(cols):
        w_c = col_w[idx]
        if idx == 0:
            parts.append(f'<text x="{cx_cur + 11:.1f}" y="{my + 17}" font-family="{FONT_UI}" font-size="10.2" font-weight="700" fill="{th["fg_muted"]}">{esc(cname)}</text>')
        else:
            parts.append(f'<text x="{cx_cur + w_c/2:.1f}" y="{my + 17}" text-anchor="middle" font-family="{FONT_MONO}" font-size="10.2" font-weight="700" fill="{th["fg_muted"]}">{esc(cname)}</text>')
        if idx > 0:
            sw_line = "1.6" if idx == 2 else "1"
            sc_line = th["card_border"] if idx == 2 else th["line"]
            parts.append(f'<line x1="{cx_cur:.1f}" y1="{my}" x2="{cx_cur:.1f}" y2="{my + total_mh}" stroke="{sc_line}" stroke-width="{sw_line}"/>')
        cx_cur += w_c

    def cell_colors(rate: int) -> tuple[str, str]:
        if rate >= 85:
            return th["heat_deep_bg"], th["ok"]
        if rate >= 65:
            return th["heat_soft_bg"], th["ch_cache"]
        if rate >= 40:
            return th["heat_amber_bg"], th["warn"]
        return th["heat_coral_bg"], th["bad"]

    pinned_anchor: tuple[float, float] = (mx + mw, my + hdr_h + row_h / 2)
    for r_idx, (mname, mmeta, cells) in enumerate(matrix_rows):
        ry = my + hdr_h + r_idx * row_h
        parts.append(f'<line x1="{mx}" y1="{ry}" x2="{mx + mw}" y2="{ry}" stroke="{th["line"]}" stroke-width="1"/>')
        parts.append(f'<text x="{mx + 11}" y="{ry + 20}" font-family="{FONT_UI}" font-size="11" font-weight="600" fill="{th["fg"]}">{esc(mname)}</text>')
        parts.append(f'<text x="{mx + 11}" y="{ry + 33}" font-family="{FONT_MONO}" font-size="9.2" fill="{th["fg_muted"]}">{esc(mmeta)}</text>')
        cx_cur = mx + col_w[0]
        for c_idx, cell in enumerate(cells):
            w_c = col_w[c_idx + 1]
            if cell is None:
                parts.append(
                    f'<text x="{cx_cur + w_c/2:.1f}" y="{ry + 27:.1f}" text-anchor="middle" '
                    f'font-family="{FONT_MONO}" font-size="11" fill="{th["fg_faint"]}">—</text>'
                )
            else:
                hit_p, keep_p, avg_c = cell
                cbg, cfg = cell_colors(hit_p)
                is_pinned = (r_idx == 0 and c_idx == 7)
                if is_pinned:
                    pinned_anchor = (cx_cur + w_c, ry + row_h / 2)
                parts.append(f'<rect x="{cx_cur + 1:.1f}" y="{ry + 1:.1f}" width="{w_c - 2:.1f}" height="{row_h - 2:.1f}" fill="{cbg}"/>')
                if is_pinned:
                    parts.append(
                        f'<rect x="{cx_cur + 1.5:.1f}" y="{ry + 1.5:.1f}" width="{w_c - 3:.1f}" height="{row_h - 3:.1f}" '
                        f'fill="none" stroke="{th["accent"]}" stroke-width="1.8" rx="2"/>'
                    )
                parts.append(
                    f'<text x="{cx_cur + w_c/2:.1f}" y="{ry + 15.5:.1f}" text-anchor="middle" '
                    f'font-family="{FONT_MONO}" font-size="11" font-weight="700" fill="{cfg}">{hit_p}%</text>'
                )
                parts.append(
                    f'<text x="{cx_cur + w_c/2:.1f}" y="{ry + 27.5:.1f}" text-anchor="middle" '
                    f'font-family="{FONT_MONO}" font-size="8.6" fill="{th["fg2"]}" opacity="0.86">{keep_p}%</text>'
                )
                parts.append(
                    f'<text x="{cx_cur + w_c/2:.1f}" y="{ry + 38.5:.1f}" text-anchor="middle" '
                    f'font-family="{FONT_MONO}" font-size="8.6" fill="{th["fg2"]}" opacity="0.86">{esc(avg_c)}</text>'
                )
            cx_cur += w_c

    # Section 2: Idle-Gap vs Hit-Rate (Log Scale)
    sc_top = my + total_mh + 14
    parts.append(f'<text x="32" y="{sc_top + 12}" font-family="{FONT_UI}" font-size="12" font-weight="700" fill="{th["fg"]}">Idle-Gap vs Hit-Rate (Log Scale)</text>')

    sc_leg = [("Hit", th["ch_uncached"], "dot"), ("0% Miss", th["bad"], "dot"), ("Boundary Cut", th["warn"], "tri"), ("Low Hit", th["fg_muted"], "dot")]
    lx = right_x - 18
    for lbl, col, shape in reversed(sc_leg):
        lw = len(lbl) * 6.0 + 18
        lx -= lw
        if shape == "tri":
            parts.append(f'<polygon points="{lx+4:.1f},{sc_top+4} {lx:.1f},{sc_top+11} {lx+8:.1f},{sc_top+11}" fill="{col}"/>')
        else:
            parts.append(f'<circle cx="{lx+4:.1f}" cy="{sc_top+8}" r="3.4" fill="{col}"/>')
        parts.append(f'<text x="{lx + 12:.1f}" y="{sc_top + 11.5}" font-family="{FONT_UI}" font-size="10.2" fill="{th["fg_muted"]}">{lbl}</text>')

    box_y, box_h = sc_top + 20, 170
    parts.append(f'<rect x="32" y="{box_y}" width="{mw}" height="{box_h}" rx="8" fill="{th["field"]}" stroke="{th["line"]}" stroke-width="1"/>')

    # Model filter pills inside scatter box
    f_pills = ["All", "Gemini 4 Neon (High)", "Gemini 4 Hydrogen (High)", "Orchestrator (Carbon)", "Claude Opus 5.5 (High)"]
    fx = 42.0
    for idx, fp in enumerate(f_pills):
        fw = text_w(fp, 10.2, bold=True) + 16
        active = idx == 0
        fbg = th["accent_bg"] if active else th["fill"]
        ffg = th["accent"] if active else th["fg_muted"]
        parts.append(f'<rect x="{fx:.1f}" y="{box_y + 9}" width="{fw:.1f}" height="20" rx="5" fill="{fbg}"/>')
        parts.append(f'<text x="{fx + fw/2:.1f}" y="{box_y + 22.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="10.2" font-weight="600" fill="{ffg}">{esc(fp)}</text>')
        fx += fw + 6

    # Plot grid
    pl, pr, pt, pb = 74.0, right_x - 36.0, box_y + 42.0, box_y + box_h - 22.0
    pw_plot = pr - pl
    ph_plot = pb - pt
    log_min, log_max = math.log10(500), math.log10(600000)

    def x_for_ms(ms: float) -> float:
        c = max(500.0, min(600000.0, ms))
        return pl + ((math.log10(c) - log_min) / (log_max - log_min)) * pw_plot

    def y_for_r(r: float) -> float:
        return pt + (1.0 - max(0.0, min(1.0, r))) * ph_plot

    for r_val, r_lbl in [(1.0, "100%"), (0.5, "50%"), (0.0, "0%")]:
        yy = y_for_r(r_val)
        parts.append(f'<line x1="{pl}" y1="{yy:.1f}" x2="{pr}" y2="{yy:.1f}" stroke="{th["border"]}" stroke-width="1"/>')
        parts.append(f'<text x="{pl - 8}" y="{yy + 3.5:.1f}" text-anchor="end" font-family="{FONT_MONO}" font-size="9.5" fill="{th["fg_muted"]}">{r_lbl}</text>')

    for ms_val, ms_lbl in [(1000, "1s"), (5000, "5s"), (20000, "20s"), (60000, "1m"), (300000, "5m")]:
        xx = x_for_ms(ms_val)
        parts.append(f'<line x1="{xx:.1f}" y1="{pt}" x2="{xx:.1f}" y2="{pb}" stroke="{th["border"]}" stroke-width="1" stroke-dasharray="3,3"/>')
        parts.append(f'<text x="{xx:.1f}" y="{pb + 13}" text-anchor="middle" font-family="{FONT_MONO}" font-size="9.5" fill="{th["fg_muted"]}">{ms_lbl}</text>')

    # Deterministic realistic scatter points reflecting >5m TTL cliff + occasional mid-gap drops
    rng = random.Random(1533)
    for _ in range(135):
        ms = 10 ** rng.uniform(math.log10(620), math.log10(260000))
        hr = rng.uniform(0.86, 0.99)
        parts.append(f'<circle cx="{x_for_ms(ms):.1f}" cy="{y_for_r(hr):.1f}" r="3.0" fill="{th["ch_uncached"]}" fill-opacity="0.56"/>')
    for _ in range(14):
        ms = 10 ** rng.uniform(math.log10(8000), math.log10(420000))
        hr = rng.uniform(0.38, 0.74)
        parts.append(f'<circle cx="{x_for_ms(ms):.1f}" cy="{y_for_r(hr):.1f}" r="2.7" fill="{th["fg_muted"]}" fill-opacity="0.62"/>')
    miss_gaps = [4800, 11500, 16200, 24000, 46000, 82000, 145000, 230000, 315000, 350000, 395000, 440000, 490000, 540000, 580000]
    for ms in miss_gaps:
        cx_p, cy_p = x_for_ms(ms), y_for_r(0.0)
        parts.append(f'<circle cx="{cx_p:.1f}" cy="{cy_p:.1f}" r="4.3" fill="{th["bad"]}" fill-opacity="0.93" stroke="{th["surface"]}" stroke-width="0.9"/>')
    for ms, hr in [(12400, 0.14), (58000, 0.21), (185000, 0.12), (340000, 0.18)]:
        cx_p, cy_p = x_for_ms(ms), y_for_r(hr)
        parts.append(f'<polygon points="{cx_p:.1f},{cy_p-4.8:.1f} {cx_p-4.3:.1f},{cy_p+3.8:.1f} {cx_p+4.3:.1f},{cy_p+3.8:.1f}" fill="{th["warn"]}" stroke="{th["surface"]}" stroke-width="0.8"/>')

    # Section 3: Action buttons & Top 2 Anomalies
    act_y = box_y + box_h + 12
    parts.append(f'<rect x="32" y="{act_y}" width="174" height="26" rx="6" fill="{th["surface"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="119" y="{act_y + 16.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="11" font-weight="500" fill="{th["fg"]}">Hide Top Anomalies (20)</text>')

    parts.append(f'<rect x="{right_x - 18 - 166}" y="{act_y}" width="166" height="26" rx="6" fill="{th["accent_bg"]}" stroke="{th["accent_border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{right_x - 18 - 83}" y="{act_y + 16.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="11" font-weight="600" fill="{th["accent"]}">Copy Issue Markdown</text>')

    anomalies = [
        ("Gemini 4 Neon (High)", "Unexpected 0% Miss", True, "-$1.42", "218.4k tok", "Idle 6m14s / Start 6m28s", "96% → 0% → 97%", "req_demo_4108", th["bad_bg"], th["bad"]),
        ("Orchestrator (Carbon)", "Boundary Cut", True, "-$0.74", "164.2k tok", "Idle 1m32s / Start 1m44s", "91% → 14% → 93%", "req_demo_4192", th["warn_bg"], th["warn"]),
    ]
    ay = act_y + 34
    for mname, kind_lbl, bounce, pen, tok, gap_s, seq_s, req_id, kbg, kfg in anomalies:
        parts.append(f'<rect x="32" y="{ay}" width="{mw}" height="44" rx="7" fill="{th["field"]}" stroke="{th["line"]}" stroke-width="1"/>')
        parts.append(f'<text x="44" y="{ay + 18}" font-family="{FONT_UI}" font-size="11" font-weight="700" fill="{th["fg"]}">{esc(mname)}</text>')
        px_tag = 44 + text_w(mname, 11, bold=True) + 9
        pk, pkw = svg_pill(px_tag, ay + 5, kind_lbl, kbg, kfg, font_size=9.2, h=17, pad_x=7)
        parts.append(pk)
        if bounce:
            pb_p, _ = svg_pill(px_tag + pkw + 6, ay + 5, "Bounce-Back", th["ok_bg"], th["ok"], font_size=9.2, h=17, pad_x=7)
            parts.append(pb_p)
        tok_s = f"({tok})"
        parts.append(f'<text x="{right_x - 30}" y="{ay + 18}" text-anchor="end" font-family="{FONT_MONO}" font-size="10.5" fill="{th["fg_muted"]}">{esc(tok_s)}</text>')
        tok_w = text_w(tok_s, 10.5, mono=True)
        parts.append(f'<text x="{right_x - 30 - tok_w - 6:.1f}" y="{ay + 18}" text-anchor="end" font-family="{FONT_MONO}" font-size="11" font-weight="700" fill="{th["bad"]}">{esc(pen)}</text>')
        parts.append(f'<text x="44" y="{ay + 34}" font-family="{FONT_MONO}" font-size="10" fill="{th["fg_muted"]}">{esc(gap_s)}</text>')
        parts.append(f'<text x="{cx + cw/2:.1f}" y="{ay + 34}" text-anchor="middle" font-family="{FONT_MONO}" font-size="10" fill="{th["fg2"]}">{esc(seq_s)}</text>')
        parts.append(f'<text x="{right_x - 30}" y="{ay + 34}" text-anchor="end" font-family="{FONT_MONO}" font-size="10" fill="{th["fg_muted"]}">{esc(req_id)}</text>')
        ay += 50

    # =========================================================================
    # Right Callout Column: Interactive Popovers (Config + Pinned Cell Detail)
    # =========================================================================
    pop_x = 1018
    pop_w = W - pop_x - 16  # 346px

    # 1) Metric Config Popover (Top Right)
    mp_y = 48
    mp_h = 264
    parts.append(
        f'<text x="{pop_x + 2}" y="{mp_y - 10}" font-family="{FONT_MONO}" font-size="9.5" font-weight="700" '
        f'letter-spacing="0.8" fill="{th["fg_muted"]}">METRIC CONFIG POPOVER</text>'
    )
    # Connector from Hit % +2 trigger to Metric Config Popover
    parts.append(
        f'<path d="M {trig_x + trig_w:.1f},{trig_y + trig_h/2:.1f} C {trig_x + trig_w + 22:.1f},{trig_y + trig_h/2:.1f} '
        f'{pop_x - 22:.1f},{mp_y + 30:.1f} {pop_x:.1f},{mp_y + 30:.1f}" '
        f'fill="none" stroke="{th["accent"]}" stroke-width="1.3" stroke-dasharray="4,3" opacity="0.85"/>'
    )
    parts.append(f'<circle cx="{trig_x + trig_w:.1f}" cy="{trig_y + trig_h/2:.1f}" r="3" fill="{th["accent"]}"/>')
    parts.append(f'<circle cx="{pop_x:.1f}" cy="{mp_y + 30:.1f}" r="3" fill="{th["accent"]}"/>')

    parts.append(
        f'<rect x="{pop_x}" y="{mp_y}" width="{pop_w}" height="{mp_h}" rx="10" '
        f'fill="{th["surface"]}" stroke="{th["accent_border"]}" stroke-width="1.2"/>'
    )
    # Popover header
    parts.append(f'<text x="{pop_x + 14}" y="{mp_y + 24}" font-family="{FONT_UI}" font-size="12" font-weight="700" fill="{th["fg"]}">Matrix Metrics</text>')
    parts.append(f'<text x="{pop_x + pop_w - 14}" y="{mp_y + 24}" text-anchor="end" font-family="{FONT_UI}" font-size="11" font-weight="600" fill="{th["accent"]}">Reset</text>')
    parts.append(f'<line x1="{pop_x + 12}" y1="{mp_y + 35}" x2="{pop_x + pop_w - 12}" y2="{mp_y + 35}" stroke="{th["line"]}" stroke-width="1"/>')

    # Column labels
    c_pri_x = pop_x + pop_w - 96
    c_sub_x = pop_x + pop_w - 34
    parts.append(f'<text x="{pop_x + 14}" y="{mp_y + 52}" font-family="{FONT_UI}" font-size="10" font-weight="600" fill="{th["fg_muted"]}">Metric</text>')
    parts.append(f'<text x="{c_pri_x}" y="{mp_y + 52}" text-anchor="middle" font-family="{FONT_UI}" font-size="10" font-weight="600" fill="{th["fg_muted"]}">Primary</text>')
    parts.append(f'<text x="{c_sub_x}" y="{mp_y + 52}" text-anchor="middle" font-family="{FONT_UI}" font-size="10" font-weight="600" fill="{th["fg_muted"]}">In-Cell</text>')

    cfg_metrics = [
        ("Token Hit Ratio", True, False),
        ("Cache Keep Rate", False, True),
        ("Avg Cost / Turn", False, True),
        ("Bucket Total Cost", False, False),
        ("Miss Penalty", False, False),
        ("Follow-up Turns", False, False),
    ]
    my_row = mp_y + 62
    for label, is_pri, is_sub in cfg_metrics:
        if is_pri:
            parts.append(
                f'<rect x="{pop_x + 8}" y="{my_row - 3}" width="{pop_w - 16}" height="24" rx="5" fill="{th["accent_bg"]}" opacity="0.62"/>'
            )
        parts.append(f'<text x="{pop_x + 14}" y="{my_row + 12.5}" font-family="{FONT_UI}" font-size="11" font-weight="{"600" if is_pri else "500"}" fill="{th["fg"]}">{esc(label)}</text>')
        # Radio button
        r_stroke = th["accent"] if is_pri else th["border"]
        parts.append(f'<circle cx="{c_pri_x}" cy="{my_row + 9}" r="7" fill="{th["field"]}" stroke="{r_stroke}" stroke-width="1.3"/>')
        if is_pri:
            parts.append(f'<circle cx="{c_pri_x}" cy="{my_row + 9}" r="3.4" fill="{th["accent"]}"/>')
            # Main tag
            ptag, _ = svg_pill(c_sub_x - 19, my_row + 1, "Main", th["accent_bg"], th["accent"], font_size=9.2, h=16, pad_x=7)
            parts.append(ptag)
        else:
            cb_fill = th["accent"] if is_sub else th["field"]
            cb_stroke = th["accent"] if is_sub else th["border"]
            parts.append(f'<rect x="{c_sub_x - 8}" y="{my_row + 1}" width="16" height="16" rx="4" fill="{cb_fill}" stroke="{cb_stroke}" stroke-width="1.2"/>')
            if is_sub:
                parts.append(
                    f'<path d="M {c_sub_x - 4.2},{my_row + 9.2} L {c_sub_x - 1.2},{my_row + 12.2} L {c_sub_x + 4.4},{my_row + 5.8}" '
                    f'fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
                )
        my_row += 26

    parts.append(f'<line x1="{pop_x + 12}" y1="{mp_y + mp_h - 40}" x2="{pop_x + pop_w - 12}" y2="{mp_y + mp_h - 40}" stroke="{th["line"]}" stroke-width="1"/>')
    parts.append(f'<text x="{pop_x + 14}" y="{mp_y + mp_h - 24}" font-family="{FONT_UI}" font-size="9.5" fill="{th["fg_muted"]}">Stack any number of in-cell sub-rows. Switching primary</text>')
    parts.append(f'<text x="{pop_x + 14}" y="{mp_y + mp_h - 11}" font-family="{FONT_UI}" font-size="9.5" fill="{th["fg_muted"]}">automatically retains the previous primary as a sub-row.</text>')

    # 2) Pinned Cell Detail Card (Bottom Right)
    dp_y = 348
    dp_h = 412
    parts.append(
        f'<text x="{pop_x + 2}" y="{dp_y - 10}" font-family="{FONT_MONO}" font-size="9.5" font-weight="700" '
        f'letter-spacing="0.8" fill="{th["fg_muted"]}">HOVER PREVIEW / PINNED CELL DETAIL</text>'
    )
    # Connector from pinned >5m cell to detail card
    pax, pay = pinned_anchor
    parts.append(
        f'<path d="M {pax:.1f},{pay:.1f} C {pax + 26:.1f},{pay:.1f} '
        f'{pop_x - 28:.1f},{dp_y + 38:.1f} {pop_x:.1f},{dp_y + 38:.1f}" '
        f'fill="none" stroke="{th["accent"]}" stroke-width="1.3" stroke-dasharray="4,3" opacity="0.85"/>'
    )
    parts.append(f'<circle cx="{pax:.1f}" cy="{pay:.1f}" r="3" fill="{th["accent"]}"/>')
    parts.append(f'<circle cx="{pop_x:.1f}" cy="{dp_y + 38:.1f}" r="3" fill="{th["accent"]}"/>')

    parts.append(
        f'<rect x="{pop_x}" y="{dp_y}" width="{pop_w}" height="{dp_h}" rx="10" '
        f'fill="{th["surface"]}" stroke="{th["accent_border"]}" stroke-width="1.2"/>'
    )

    # Detail header
    parts.append(f'<text x="{pop_x + 14}" y="{dp_y + 25}" font-family="{FONT_UI}" font-size="11.5" font-weight="700" fill="{th["fg"]}">Gemini 4 Neon (High)</text>')
    mn_w = text_w("Gemini 4 Neon (High)", 11.5, bold=True)
    parts.append(f'<text x="{pop_x + 14 + mn_w + 5:.1f}" y="{dp_y + 25}" font-family="{FONT_UI}" font-size="11" fill="{th["fg_faint"]}">·</text>')
    parts.append(f'<text x="{pop_x + 14 + mn_w + 13:.1f}" y="{dp_y + 25}" font-family="{FONT_MONO}" font-size="11" font-weight="700" fill="{th["accent"]}">&gt;5m</text>')
    parts.append(f'<text x="{pop_x + pop_w - 38}" y="{dp_y + 25}" text-anchor="end" font-family="{FONT_MONO}" font-size="10.2" fill="{th["fg_muted"]}">24 turns</text>')
    # Close button [x]
    parts.append(f'<rect x="{pop_x + pop_w - 30}" y="{dp_y + 11}" width="18" height="18" rx="4" fill="{th["field"]}"/>')
    parts.append(f'<text x="{pop_x + pop_w - 21}" y="{dp_y + 24}" text-anchor="middle" font-family="{FONT_UI}" font-size="12" fill="{th["fg_muted"]}">×</text>')
    parts.append(f'<line x1="{pop_x + 12}" y1="{dp_y + 38}" x2="{pop_x + pop_w - 12}" y2="{dp_y + 38}" stroke="{th["line"]}" stroke-width="1"/>')

    def draw_detail_row(
        y_pos: float,
        lbl: str,
        val: str,
        val_col: str,
        tag: str = "",
        sub_val: str = "",
    ) -> None:
        parts.append(f'<text x="{pop_x + 14}" y="{y_pos:.1f}" font-family="{FONT_UI}" font-size="11" fill="{th["fg_muted"]}">{esc(lbl)}</text>')
        if tag:
            lw_t = text_w(lbl, 11, bold=False)
            tbg = th["accent_bg"] if tag == "Main" else th["field"]
            tfg = th["accent"] if tag == "Main" else th["fg2"]
            tp, _ = svg_pill(pop_x + 14 + lw_t + 6, y_pos - 11.5, tag, tbg, tfg, font_size=8.8, h=15, pad_x=5)
            parts.append(tp)
        rx = pop_x + pop_w - 14
        if sub_val:
            parts.append(f'<text x="{rx}" y="{y_pos:.1f}" text-anchor="end" font-family="{FONT_MONO}" font-size="9.6" fill="{th["fg_muted"]}">{esc(sub_val)}</text>')
            sw = text_w(sub_val, 9.6, mono=True)
            parts.append(f'<text x="{rx - sw - 5:.1f}" y="{y_pos:.1f}" text-anchor="end" font-family="{FONT_MONO}" font-size="11" font-weight="700" fill="{val_col}">{esc(val)}</text>')
        else:
            parts.append(f'<text x="{rx}" y="{y_pos:.1f}" text-anchor="end" font-family="{FONT_MONO}" font-size="11" font-weight="700" fill="{val_col}">{esc(val)}</text>')

    # Group 1: Cache Performance
    dy = dp_y + 58
    draw_detail_row(dy, "Token Hit Ratio", "22.4%", th["bad"], tag="Main", sub_val="(avg 24.8%)")
    dy += 26
    draw_detail_row(dy, "Cache Keep Rate", "25.0% (6/24)", th["fg"], tag="Sub")
    dy += 26
    draw_detail_row(dy, "Anomalies", "14 0%-miss · 2 cut · 11 bounce", th["bad"])
    dy += 14
    parts.append(f'<line x1="{pop_x + 12}" y1="{dy}" x2="{pop_x + pop_w - 12}" y2="{dy}" stroke="{th["line"]}" stroke-width="1"/>')

    # Group 2: Cost & Impact
    dy += 22
    draw_detail_row(dy, "Avg Cost / Turn", "$1.32", th["fg"], tag="Sub")
    dy += 26
    draw_detail_row(dy, "Bucket Total Cost", "$31.68", th["fg"])
    dy += 26
    draw_detail_row(dy, "Miss Penalty", "$19.45", th["bad"], sub_val="($0.81/t)")
    dy += 26
    draw_detail_row(dy, "Cache Saved", "$11.20", th["ok"])
    dy += 14
    parts.append(f'<line x1="{pop_x + 12}" y1="{dy}" x2="{pop_x + pop_w - 12}" y2="{dy}" stroke="{th["line"]}" stroke-width="1"/>')

    # Group 3: Token Scale
    dy += 22
    draw_detail_row(dy, "Avg Input Context", "194.2k", th["fg"])
    dy += 26
    draw_detail_row(dy, "Cache Read / Input", "1.04M / 4.66M", th["fg"])
    dy += 26
    draw_detail_row(dy, "Wasted Tokens", "3.18M", th["bad"])

    # Footer
    fy = dp_y + dp_h - 26
    parts.append(f'<line x1="{pop_x + 12}" y1="{fy}" x2="{pop_x + pop_w - 12}" y2="{fy}" stroke="{th["line"]}" stroke-width="1" stroke-dasharray="3,3"/>')
    parts.append(
        f'<text x="{pop_x + pop_w/2:.1f}" y="{fy + 16}" text-anchor="middle" '
        f'font-family="{FONT_UI}" font-size="9.5" fill="{th["fg_muted"]}">Pinned cell detail · click cell or Esc to close</text>'
    )

    parts.append("</svg>")
    return "\n".join(parts)


def render_cache_observatory() -> Path:
    svg_str = build_cache_observatory_svg()
    img = composite_panels(
        1440,
        834,
        [(svg_str, 30, 30, 14)],
        scale=2,
        top_rgb=(16, 19, 27),
        bot_rgb=(10, 12, 18),
    )
    out = OUT_DIR / "cache-observatory.png"
    img.save(out, optimize=True)
    return out


# ---------------------------------------------------------------------------
# 3. Cost Breakdown & 16-Week Calendar Heatmap
# ---------------------------------------------------------------------------
def build_cost_card_svg(th: dict[str, Any]) -> str:
    W, H = 532, 608
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        f'<rect width="{W}" height="{H}" fill="{th["surface"]}"/>',
    ]
    cost_title = "Models & API-Eq. Cost"
    parts.append(f'<text x="18" y="29" font-family="{FONT_UI}" font-size="14" font-weight="700" fill="{th["fg"]}">{esc(cost_title)}</text>')
    parts.append(svg_help_dot(18 + text_w(cost_title, 14, bold=True) + 12, 24.5, th))
    p_eq, _ = svg_pill(W - 96, 15, "API-eq.", "none", th["fg_muted"], border=th["border"], font_size=10, h=19, pad_x=8)
    parts.append(p_eq)
    parts.append(svg_chevron(W - 22, 24.5, th["fg_muted"], up=True))

    # Big headline + pills
    parts.append(f'<text x="18" y="64" font-family="{FONT_MONO}" font-size="24" font-weight="700" fill="{th["fg"]}">$71.84</text>')
    ps_w = pill_width("Saved $234.09", font_size=10, pad_x=8, mono=True)
    pl_w = pill_width(">200k 118t", font_size=10, pad_x=8, mono=True)
    ps, _ = svg_pill(W - 18 - pl_w - 6 - ps_w, 46, "Saved $234.09", th["ok_bg"], th["ok"], font_size=10, h=20, pad_x=8, mono=True)
    parts.append(ps)
    pl, _ = svg_pill(W - 18 - pl_w, 46, ">200k 118t", th["warn_bg"], th["warn"], font_size=10, h=20, pad_x=8, mono=True)
    parts.append(pl)

    # Top model pills
    p1_lbl = "Gemini 4 Neon (High) · 71%"
    p1_w = pill_width(p1_lbl, font_size=10, pad_x=8)
    top_pills = [
        (p1_lbl, 18.0, 78),
        ("Claude Opus 5.5 (High) · 19%", 18.0 + p1_w + 8, 78),
        ("Gemini 4 Hydrogen (High) · 7%", 18.0, 102),
    ]
    for lbl, px, py in top_pills:
        pp, _ = svg_pill(px, py, lbl, th["fill"], th["fg2"], font_size=10, h=20, pad_x=8)
        parts.append(pp)

    parts.append(f'<line x1="18" y1="134" x2="{W - 18}" y2="134" stroke="{th["line"]}" stroke-width="1"/>')

    # Toolbar: Models (4) | Workspaces (3) + sort buttons
    parts.append(f'<rect x="18" y="144" width="178" height="24" rx="6" fill="{th["fill"]}"/>')
    parts.append(f'<rect x="20" y="146" width="84" height="20" rx="4" fill="{th["surface"]}"/>')
    parts.append(f'<text x="62" y="159.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" font-weight="600" fill="{th["fg"]}">Models (4)</text>')
    parts.append(f'<text x="148" y="159.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Workspaces (3)</text>')

    sorts = ["Cost", "Tokens", "Turns", "Cache%"]
    sx = W - 18
    for s_lbl in reversed(sorts):
        sw = len(s_lbl) * 6.4 + 12
        sx -= sw + 4
        active = s_lbl == "Cost"
        parts.append(f'<rect x="{sx:.1f}" y="145" width="{sw:.1f}" height="22" rx="4" fill="{th["accent_bg"] if active else th["fill"]}"/>')
        parts.append(f'<text x="{sx + sw/2:.1f}" y="159.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10" font-weight="{"700" if active else "500"}" fill="{th["accent"] if active else th["fg_muted"]}">{s_lbl}</text>')

    # Model rows
    models = [
        ("Gemini 4 Neon (High)", True, "$51.18", "184 turns · 33.34M tok · Cache 77%", "Default", "2x >200k tier: $6.00/1M in · $0.30/1M cache"),
        ("Claude Opus 5.5 (High)", False, "$13.75", "85 turns · 18.20M tok · Cache 94%", "Default", "Long-context 51 turns · Saved $110.44"),
        ("Gemini 4 Hydrogen (High)", False, "$5.04", "64 turns · 11.22M tok · Cache 84%", "Default", "Standard rate · $1.50/1M in · $0.075/1M cache"),
        ("Gemini 3.8 Flash", False, "$1.88", "48 turns · 8.40M tok · Cache 88%", "Default", "Intro rate · 0.1x cache read ($0.075/1M)"),
    ]
    my = 180
    for name, has_200k, cost_s, sub_s, src_lbl, note_s in models:
        parts.append(f'<rect x="18" y="{my}" width="{W - 36}" height="74" rx="7" fill="{th["field"]}"/>')
        parts.append(f'<text x="28" y="{my + 20}" font-family="{FONT_UI}" font-size="12" font-weight="600" fill="{th["fg"]}">{esc(name)}</text>')
        if has_200k:
            p2, _ = svg_pill(28 + text_w(name, 12, bold=True) + 8, my + 7, ">200k", th["warn_bg"], th["warn"], font_size=9.5, h=18, pad_x=6, mono=True)
            parts.append(p2)
        parts.append(f'<text x="{W - 28}" y="{my + 20}" text-anchor="end" font-family="{FONT_MONO}" font-size="12.5" font-weight="700" fill="{th["fg"]}">{esc(cost_s)}</text>')
        parts.append(f'<text x="28" y="{my + 41}" font-family="{FONT_MONO}" font-size="10.5" fill="{th["fg_muted"]}">{esc(sub_s)}</text>')
        psrc, _ = svg_pill(W - 82, my + 29, src_lbl, "none", th["fg_muted"], border=th["border"], font_size=9.5, h=18, pad_x=6)
        parts.append(psrc)
        parts.append(f'<text x="28" y="{my + 60}" font-family="{FONT_MONO}" font-size="9.5" fill="{th["fg_faint"]}">{esc(note_s)}</text>')
        my += 82

    # Bottom >200k explainer banner
    parts.append(f'<rect x="18" y="{my + 4}" width="{W - 36}" height="76" rx="7" fill="{th["warn_bg"]}"/>')
    parts.append(f'<text x="30" y="{my + 24}" font-family="{FONT_UI}" font-size="11" font-weight="700" fill="{th["warn"]}">Long-Context Tiered Billing (&gt;200k Prompt Tokens)</text>')
    parts.append(f'<text x="30" y="{my + 43}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg2"]}">Turns exceeding 200k prompt tokens automatically switch to above-</text>')
    parts.append(f'<text x="30" y="{my + 59}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg2"]}">threshold rates ($6/1M in, $30/1M out, $0.30/1M cache read).</text>')

    parts.append("</svg>")
    return "\n".join(parts)


def build_calendar_card_svg(th: dict[str, Any]) -> str:
    W, H = 564, 608
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        f'<rect width="{W}" height="{H}" fill="{th["surface"]}"/>',
    ]
    cal_title = "Calendar Heatmap & Trends"
    parts.append(f'<text x="18" y="29" font-family="{FONT_UI}" font-size="14" font-weight="700" fill="{th["fg"]}">{esc(cal_title)}</text>')
    parts.append(svg_help_dot(18 + text_w(cal_title, 14, bold=True) + 12, 24.5, th))
    ps_pill, _ = svg_pill(W - 110, 15, "6d streak", th["ok_bg"], th["ok"], font_size=10, h=19, pad_x=8, mono=True)
    parts.append(ps_pill)
    parts.append(svg_chevron(W - 22, 24.5, th["fg_muted"], up=True))

    # Compact stats + 14-day sparkbars
    parts.append(f'<text x="18" y="56" font-family="{FONT_MONO}" font-size="15.5" font-weight="700" fill="{th["fg"]}">Today $24.15</text>')
    parts.append(f'<text x="{18 + text_w("Today $24.15", 15.5, bold=True, mono=True) + 8:.1f}" y="56" font-family="{FONT_MONO}" font-size="11" fill="{th["fg_muted"]}">/ 7d avg $6.86</text>')
    pd_pill, _ = svg_pill(18, 66, "+251.7% vs 7d avg", th["warn_bg"], th["warn"], font_size=10, h=19, pad_x=8, mono=True)
    parts.append(pd_pill)

    spark_vals = [1.52, 1.57, 1.96, 0.59, 2.65, 0.62, 1.50, 0.36, 0.0, 5.01, 9.24, 8.19, 9.50, 24.15]
    max_sp = max(spark_vals)
    spx0, spy0 = W - 182, 42
    for idx, sv in enumerate(spark_vals):
        sh = max(3.0, (sv / max_sp) * 38.0) if sv > 0 else 2.5
        scol = th["ch_cache"] if sv > 0 else th["hm"][0]
        parts.append(f'<rect x="{spx0 + idx * 11.5:.1f}" y="{spy0 + 40 - sh:.1f}" width="8" height="{sh:.1f}" rx="1.8" fill="{scol}"/>')

    parts.append(f'<line x1="18" y1="98" x2="{W - 18}" y2="98" stroke="{th["line"]}" stroke-width="1"/>')

    # Metric switcher + Less/More legend
    parts.append(f'<rect x="18" y="108" width="186" height="24" rx="6" fill="{th["fill"]}"/>')
    parts.append(f'<rect x="20" y="110" width="64" height="20" rx="4" fill="{th["surface"]}"/>')
    parts.append(f'<text x="52" y="123.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" font-weight="600" fill="{th["fg"]}">API-eq. $</text>')
    parts.append(f'<text x="114" y="123.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Tokens</text>')
    parts.append(f'<text x="170" y="123.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Turns</text>')

    parts.append(f'<text x="{W - 122}" y="123.5" font-family="{FONT_UI}" font-size="10" fill="{th["fg_muted"]}">Less</text>')
    for i, hcol in enumerate(th["hm"]):
        parts.append(f'<rect x="{W - 92 + i * 12}" y="114.5" width="9" height="9" rx="2" fill="{hcol}"/>')
    parts.append(f'<text x="{W - 28}" y="123.5" font-family="{FONT_UI}" font-size="10" fill="{th["fg_muted"]}">More</text>')

    # 16-week crisp 1:1 heatmap (scaled up nicely at 22px cell + 5px gap -> fits 528px cleanly!)
    # 16 cols * (24 + 5) = 464px + 34 left pad = 498px! Super crisp!
    cell_sz, gap = 24, 5
    left_pad, top_pad = 48, 166
    months = [(0, "Aug"), (4, "Sep"), (9, "Oct"), (13, "Nov")]
    for col_i, mlbl in months:
        parts.append(f'<text x="{left_pad + col_i * (cell_sz + gap)}" y="{top_pad - 8}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">{mlbl}</text>')
    for row_i, dlbl in [(0, "Mon"), (2, "Wed"), (4, "Fri")]:
        parts.append(f'<text x="18" y="{top_pad + row_i * (cell_sz + gap) + 16}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">{dlbl}</text>')

    rng = random.Random(20261120)
    for col_i in range(16):
        for row_i in range(7):
            if col_i == 15 and row_i > 4:
                continue  # Future days in current week
            if col_i == 15 and row_i == 4:
                lvl = 4  # Today (selected)
            elif col_i >= 14:
                lvl = 3 if row_i < 3 else 4
            else:
                r = rng.random()
                lvl = 0 if r < 0.14 else 1 if r < 0.36 else 2 if r < 0.62 else 3 if r < 0.86 else 4
            cx_cell = left_pad + col_i * (cell_sz + gap)
            cy_cell = top_pad + row_i * (cell_sz + gap)
            is_sel = col_i == 15 and row_i == 4
            sel_attr = f' stroke="{th["accent"]}" stroke-width="2.2"' if is_sel else ""
            parts.append(f'<rect x="{cx_cell}" y="{cy_cell}" width="{cell_sz}" height="{cell_sz}" rx="4.5" fill="{th["hm"][lvl]}"{sel_attr}/>')

    hint_y = top_pad + 7 * (cell_sz + gap) + 12
    parts.append(f'<text x="18" y="{hint_y}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Selected date drill-down · Click any day cell to inspect sessions</text>')

    # Day Drill-down card
    dy = hint_y + 12
    dh = H - dy - 16
    parts.append(f'<rect x="18" y="{dy}" width="{W - 36}" height="{dh}" rx="9" fill="{th["field"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="30" y="{dy + 22}" font-family="{FONT_MONO}" font-size="12" font-weight="700" fill="{th["fg"]}">2026-11-20 · $24.15 · 23.02M tok · 125 turns</text>')
    parts.append(f'<text x="{W - 30}" y="{dy + 22}" text-anchor="end" font-family="{FONT_UI}" font-size="10.5" font-weight="600" fill="{th["accent"]}">Close</text>')

    convs = [
        ("Optimize async worker pool scheduling", "Desktop · acme-web · 18 turns", "$5.44"),
        ("SIMD parser benchmark", "CLI · rust-engine · 18 turns", "$4.03"),
        ("Optimize prompt cache prefix alignment", "Desktop · acme-web · 26 turns", "$3.99"),
    ]
    cy_row = dy + 34
    for title, meta, c_usd in convs:
        parts.append(f'<rect x="30" y="{cy_row}" width="{W - 60}" height="42" rx="6" fill="{th["surface"]}"/>')
        parts.append(f'<text x="40" y="{cy_row + 17}" font-family="{FONT_UI}" font-size="11.5" font-weight="600" fill="{th["fg"]}">{title}</text>')
        parts.append(f'<text x="40" y="{cy_row + 33}" font-family="{FONT_MONO}" font-size="10" fill="{th["fg_muted"]}">{meta}</text>')
        parts.append(f'<text x="{W - 40}" y="{cy_row + 25}" text-anchor="end" font-family="{FONT_MONO}" font-size="12" font-weight="700" fill="{th["fg"]}">{c_usd}</text>')
        cy_row += 48

    parts.append("</svg>")
    return "\n".join(parts)


def render_cost_calendar() -> Path:
    cost_svg = build_cost_card_svg(DARK)
    cal_svg = build_calendar_card_svg(DARK)
    img = composite_panels(
        1180,
        668,
        [(cost_svg, 30, 30, 12), (cal_svg, 586, 30, 12)],
        scale=2,
        top_rgb=(17, 20, 28),
        bot_rgb=(11, 13, 19),
    )
    out = OUT_DIR / "cost-calendar.png"
    img.save(out, optimize=True)
    return out


# ---------------------------------------------------------------------------
# 4. Quota Alignment & Implied Cycle Budget
# ---------------------------------------------------------------------------
def build_quota_budget_svg() -> str:
    th = DARK
    W, H = 880, 580
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        f'<rect width="{W}" height="{H}" fill="{th["surface"]}"/>',
    ]

    # Header
    q_title = "Quota & Cycle Budget"
    parts.append(f'<text x="22" y="32" font-family="{FONT_UI}" font-size="14.5" font-weight="700" fill="{th["fg"]}">{esc(q_title)}</text>')
    parts.append(svg_help_dot(22 + text_w(q_title, 14.5, bold=True) + 12, 27.5, th))
    # Left | Used toggle
    parts.append(f'<rect x="{W - 144}" y="16" width="96" height="22" rx="6" fill="{th["fill"]}"/>')
    parts.append(f'<rect x="{W - 142}" y="18" width="46" height="18" rx="4" fill="{th["surface"]}"/>')
    parts.append(f'<text x="{W - 119}" y="30.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" font-weight="600" fill="{th["fg"]}">Left</text>')
    parts.append(f'<text x="{W - 72}" y="30.5" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Used</text>')
    parts.append(svg_chevron(W - 28, 27.5, th["fg_muted"], up=True))

    # Top Pool Summary Cards (2 columns)
    pools = [
        ("Gemini · 5h", "High CI", "78.50%", "Step 0.01% · 16m ago", "Pace 0.61x · Healthy", "Projected now: 78.20%", "Reset in 3h 15m"),
        ("Gemini · 7d", "High CI", "81.65%", "Step 0.01% · 16m ago", "Pace 0.43x · Healthy", "Projected now: 81.40%", "Reset in 4d 0h"),
    ]
    pw = (W - 56) / 2
    for i, (ptitle, ci_lbl, pct, step_s, pace_s, proj_s, rst_s) in enumerate(pools):
        px = 22 + i * (pw + 12)
        py = 48
        parts.append(f'<rect x="{px:.1f}" y="{py}" width="{pw:.1f}" height="86" rx="8" fill="{th["field"]}" stroke="{th["line"]}" stroke-width="1"/>')
        parts.append(f'<text x="{px + 12:.1f}" y="{py + 21}" font-family="{FONT_UI}" font-size="12" font-weight="700" fill="{th["fg"]}">{ptitle}</text>')
        pci, _ = svg_pill(px + pw - 68, py + 8, ci_lbl, th["ok_bg"], th["ok"], font_size=9.5, h=18, pad_x=7)
        parts.append(pci)
        parts.append(f'<text x="{px + 12:.1f}" y="{py + 48}" font-family="{FONT_MONO}" font-size="20" font-weight="700" fill="{th["fg"]}">{pct}</text>')
        ppace, _ = svg_pill(px + pw - 134, py + 32, pace_s, th["ok_bg"], th["ok"], font_size=9.5, h=18, pad_x=7, mono=True)
        parts.append(ppace)
        parts.append(f'<text x="{px + 12:.1f}" y="{py + 66}" font-family="{FONT_MONO}" font-size="10" fill="{th["fg_muted"]}">{step_s}</text>')
        parts.append(f'<text x="{px + 12:.1f}" y="{py + 79}" font-family="{FONT_MONO}" font-size="10" fill="{th["fg_muted"]}">{proj_s} · {rst_s}</text>')

    parts.append(f'<line x1="22" y1="146" x2="{W - 22}" y2="146" stroke="{th["line"]}" stroke-width="1"/>')

    # Bottom split: Left = Record Alignment Anchor form | Right = Implied Cycle Budget + Anchor History
    lx, ly, lw = 22, 158, 396
    rx, ry, rw = 434, 158, W - 456

    # Left Form Card
    parts.append(f'<rect x="{lx}" y="{ly}" width="{lw}" height="400" rx="9" fill="{th["field"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{lx + 14}" y="{ly + 24}" font-family="{FONT_UI}" font-size="12.5" font-weight="700" fill="{th["fg"]}">Record Alignment Anchor</text>')

    # Quota Pool & Window dropdowns
    fw_half = (lw - 38) / 2
    for idx, (flbl, fval) in enumerate([("Quota Pool", "Gemini"), ("Window", "5h Window")]):
        fx = lx + 14 + idx * (fw_half + 10)
        parts.append(f'<text x="{fx:.1f}" y="{ly + 48}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">{flbl}</text>')
        parts.append(f'<rect x="{fx:.1f}" y="{ly + 54}" width="{fw_half:.1f}" height="30" rx="6" fill="{th["surface"]}" stroke="{th["border"]}" stroke-width="1"/>')
        parts.append(f'<text x="{fx + 10:.1f}" y="{ly + 73}" font-family="{FONT_UI}" font-size="11.5" fill="{th["fg"]}">{fval}</text>')
        parts.append(svg_chevron(fx + fw_half - 14, ly + 69, th["fg_muted"], up=False))

    # 2-decimal precision input (highlighted)
    parts.append(f'<text x="{lx + 14}" y="{ly + 106}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Current Remaining (%)</text>')
    parts.append(f'<rect x="{lx + 14}" y="{ly + 112}" width="{lw - 28}" height="34" rx="6" fill="{th["surface"]}" stroke="{th["accent"]}" stroke-width="1.6"/>')
    parts.append(f'<text x="{lx + 24}" y="{ly + 134}" font-family="{FONT_MONO}" font-size="14" font-weight="700" fill="{th["fg"]}">94.25</text>')
    parts.append(f'<line x1="{lx + 68}" y1="{ly + 120}" x2="{lx + 68}" y2="{ly + 138}" stroke="{th["accent"]}" stroke-width="1.5"/>')
    pstep, _ = svg_pill(lx + lw - 118, ly + 119, "Step 0.01%", th["accent_bg"], th["accent"], font_size=9.5, h=19, pad_x=7, mono=True)
    parts.append(pstep)
    parts.append(f'<text x="{lx + 14}" y="{ly + 160}" font-family="{FONT_UI}" font-size="9.5" fill="{th["fg_muted"]}">Up to 2 decimal places (e.g. 94.25); step auto-detected for CI.</text>')

    # Reset Countdown & Captured At
    parts.append(f'<text x="{lx + 14}" y="{ly + 186}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Reset Countdown / Time</text>')
    parts.append(f'<rect x="{lx + 14}" y="{ly + 192}" width="{fw_half:.1f}" height="30" rx="6" fill="{th["surface"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{lx + 24}" y="{ly + 211}" font-family="{FONT_MONO}" font-size="11.5" fill="{th["fg"]}">3h20m</text>')

    cap_x = lx + 14 + fw_half + 10
    parts.append(f'<text x="{cap_x:.1f}" y="{ly + 186}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Captured At</text>')
    parts.append(f'<rect x="{cap_x:.1f}" y="{ly + 192}" width="{fw_half:.1f}" height="30" rx="6" fill="{th["surface"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<rect x="{cap_x + 3:.1f}" y="{ly + 195}" width="{fw_half/2 - 4:.1f}" height="24" rx="4" fill="{th["accent_bg"]}"/>')
    parts.append(f'<text x="{cap_x + 3 + (fw_half/2 - 4)/2:.1f}" y="{ly + 211}" text-anchor="middle" font-family="{FONT_UI}" font-size="11" font-weight="600" fill="{th["accent"]}">Now</text>')
    parts.append(f'<text x="{cap_x + fw_half*0.75:.1f}" y="{ly + 211}" text-anchor="middle" font-family="{FONT_UI}" font-size="11" fill="{th["fg_muted"]}">Custom</text>')

    parts.append(f'<text x="{lx + 14}" y="{ly + 236}" font-family="{FONT_MONO}" font-size="9.5" fill="{th["ok"]}">Est. 20:10 · Leave blank to inherit</text>')

    # Note input + Save button
    parts.append(f'<text x="{lx + 14}" y="{ly + 260}" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg_muted"]}">Note (optional)</text>')
    parts.append(f'<rect x="{lx + 14}" y="{ly + 266}" width="{lw - 28}" height="30" rx="6" fill="{th["surface"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{lx + 24}" y="{ly + 285}" font-family="{FONT_UI}" font-size="11.5" fill="{th["fg2"]}">IDE settings snapshot</text>')

    parts.append(f'<rect x="{lx + 14}" y="{ly + 314}" width="{lw - 28}" height="34" rx="7" fill="{th["accent"]}"/>')
    parts.append(f'<text x="{lx + lw/2}" y="{ly + 335}" text-anchor="middle" font-family="{FONT_UI}" font-size="12" font-weight="700" fill="#ffffff">Save Anchor</text>')
    parts.append(f'<text x="{lx + lw/2}" y="{ly + 370}" text-anchor="middle" font-family="{FONT_UI}" font-size="10" fill="{th["fg_muted"]}">Stored locally in telemetry_cache.db · zero network calls</text>')

    # Right Top: Implied Cycle Total Budget Card
    parts.append(f'<rect x="{rx}" y="{ry}" width="{rw}" height="122" rx="9" fill="{th["surface"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{rx + 14}" y="{ry + 24}" font-family="{FONT_UI}" font-size="12.5" font-weight="700" fill="{th["fg"]}">Gemini · 5h Implied Budget</text>')
    p_hci, _ = svg_pill(rx + rw - 72, ry + 11, "High CI", th["ok_bg"], th["ok"], font_size=9.5, h=19, pad_x=7)
    parts.append(p_hci)

    parts.append(f'<text x="{rx + 14}" y="{ry + 56}" font-family="{FONT_MONO}" font-size="22" font-weight="700" fill="{th["fg"]}">$55.25</text>')
    parts.append(f'<text x="{rx + 112}" y="{ry + 55}" font-family="{FONT_MONO}" font-size="11" fill="{th["ok"]}">95% CI: $55.22 – $55.28</text>')
    parts.append(f'<text x="{rx + 14}" y="{ry + 80}" font-family="{FONT_MONO}" font-size="10.5" fill="{th["fg_muted"]}">Effective Δu: 17.90% (2 segs) · Window $9.89</text>')
    parts.append(f'<text x="{rx + 14}" y="{ry + 100}" font-family="{FONT_MONO}" font-size="11" font-weight="600" fill="{th["fg2"]}">Implied left: $43.37 (78.50%)</text>')

    # Right Bottom: Anchor History Timeline
    hy = ry + 134
    parts.append(f'<text x="{rx}" y="{hy + 14}" font-family="{FONT_UI}" font-size="12" font-weight="700" fill="{th["fg"]}">Anchor History (4)</text>')

    anchors = [
        ("78.50%", "Gemini · 5h", "Step 0.01%", "16m ago · After benchmark run"),
        ("84.15%", "Gemini · 5h", "Step 0.01%", "52m ago · Mid-session checkpoint"),
        ("96.40%", "Gemini · 5h", "Step 0.01%", "1h45m ago · Start of sprint session"),
        ("81.65%", "Gemini · 7d", "Step 0.01%", "16m ago · Weekly check"),
    ]
    ay = hy + 24
    for pct_s, pool_s, st_s, note_s in anchors:
        parts.append(f'<rect x="{rx}" y="{ay}" width="{rw}" height="54" rx="7" fill="{th["field"]}"/>')
        parts.append(f'<text x="{rx + 12}" y="{ay + 22}" font-family="{FONT_MONO}" font-size="13" font-weight="700" fill="{th["fg"]}">{pct_s}</text>')
        ppool, ppw = svg_pill(rx + 82, ay + 8, pool_s, th["fill"], th["fg2"], font_size=9.5, h=18, pad_x=7)
        parts.append(ppool)
        pst, _ = svg_pill(rx + 82 + ppw + 6, ay + 8, st_s, th["accent_bg"], th["accent"], font_size=9.5, h=18, pad_x=6, mono=True)
        parts.append(pst)
        parts.append(f'<text x="{rx + rw - 14}" y="{ay + 21}" text-anchor="end" font-family="{FONT_UI}" font-size="10.5" fill="{th["bad"]}">Delete</text>')
        parts.append(f'<text x="{rx + 12}" y="{ay + 42}" font-family="{FONT_UI}" font-size="10" fill="{th["fg_muted"]}">{note_s}</text>')
        ay += 60

    parts.append("</svg>")
    return "\n".join(parts)


def render_quota_budget() -> Path:
    svg_str = build_quota_budget_svg()
    img = composite_panels(
        940,
        640,
        [(svg_str, 30, 30, 14)],
        scale=2,
        top_rgb=(17, 20, 28),
        bot_rgb=(11, 13, 19),
    )
    out = OUT_DIR / "quota-budget.png"
    img.save(out, optimize=True)
    return out


# ---------------------------------------------------------------------------
# 5. Settings Drawer (7 modules, ? tooltip callout, Language, Sources, Pricing)
# ---------------------------------------------------------------------------
def build_settings_drawer_svg() -> str:
    th = DARK
    W, H = 940, 710
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
        f'<rect width="{W}" height="{H}" fill="{th["bg"]}"/>',
    ]

    # Left panel preview: live main header with compact ↑ v1.4.1 micro-pill + update popover + help callout
    lx, ly, lw, lh = 16, 16, 434, H - 32
    parts.append(f'<rect x="{lx}" y="{ly}" width="{lw}" height="{lh}" rx="10" fill="{th["surface"]}" stroke="{th["card_border"]}" stroke-width="1"/>')
    # Header bar on left panel
    parts.append(f'<rect x="{lx + 1}" y="{ly + 1}" width="{lw - 2}" height="44" rx="9" fill="{th["header_bg"]}"/>')
    parts.append(f'<line x1="{lx}" y1="{ly + 45}" x2="{lx + lw}" y2="{ly + 45}" stroke="{th["border"]}" stroke-width="1"/>')
    # Logo + title + ↑ v1.4.1 micro-pill right next to AGY Lens
    parts.append(f'<g transform="translate({lx + 12}, {ly + 12}) scale(0.156)">{extract_logo_inner("set_logo")}</g>')
    parts.append(f'<text x="{lx + 38}" y="{ly + 27}" font-family="{FONT_UI}" font-size="13.5" font-weight="700" fill="{th["fg"]}">AGY Lens</text>')
    pill_x = lx + 38 + text_w("AGY Lens", 13.5, bold=True) + 8
    pill_y = ly + 13.5
    p_upd, p_upd_w = svg_pill(pill_x, pill_y, "↑ v1.4.1", th["ok_bg"], th["ok"], font_size=9.5, h=17, pad_x=6, mono=True)
    parts.append(p_upd)
    # Right header controls (freshness, 15s, refresh, settings)
    parts.append(f'<circle cx="{lx + lw - 122}" cy="{ly + 22.5}" r="3" fill="{th["ok"]}"/>')
    parts.append(f'<text x="{lx + lw - 115}" y="{ly + 26}" font-family="{FONT_MONO}" font-size="10" fill="{th["fg_muted"]}">3s</text>')
    parts.append(f'<rect x="{lx + lw - 92}" y="{ly + 12}" width="38" height="20" rx="5" fill="{th["field"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{lx + lw - 73}" y="{ly + 25.5}" text-anchor="middle" font-family="{FONT_MONO}" font-size="9.5" fill="{th["fg"]}">15s</text>')
    parts.append(svg_refresh(lx + lw - 46, ly + 15.5, 13, th["fg_muted"]))
    parts.append(svg_gear(lx + lw - 24, ly + 15.5, 13, th["accent"]))

    # Subtle dimmed card silhouettes behind popovers on left panel
    parts.append(f'<rect x="{lx + 14}" y="{ly + 58}" width="{lw - 28}" height="108" rx="8" fill="{th["field"]}" opacity="0.35"/>')
    parts.append(f'<rect x="{lx + 14}" y="{ly + 178}" width="{lw - 28}" height="164" rx="8" fill="{th["field"]}" opacity="0.35"/>')
    parts.append(f'<rect x="{lx + 14}" y="{ly + 354}" width="{lw - 28}" height="186" rx="8" fill="{th["field"]}" opacity="0.35"/>')
    parts.append(f'<rect x="{lx + 14}" y="{ly + 552}" width="{lw - 28}" height="110" rx="8" fill="{th["field"]}" opacity="0.35"/>')

    # Floating Update Available Popover anchored cleanly below ↑ v1.4.1 micro-pill
    ux, uy, uw, uh = lx + 16, ly + 66, lw - 32, 232
    parts.append(
        f'<path d="M {pill_x + p_upd_w/2:.1f} {pill_y + 17:.1f} L {pill_x + p_upd_w/2:.1f} {uy:.1f}" '
        f'fill="none" stroke="{th["ok"]}" stroke-width="1.3" stroke-dasharray="3,2"/>'
    )
    parts.append(f'<circle cx="{pill_x + p_upd_w/2:.1f}" cy="{uy:.1f}" r="2.8" fill="{th["ok"]}"/>')
    parts.append(f'<rect x="{ux}" y="{uy}" width="{uw}" height="{uh}" rx="10" fill="{th["surface"]}" stroke="{th["accent_border"]}" stroke-width="1.4"/>')
    parts.append(f'<text x="{ux + 14}" y="{uy + 23}" font-family="{FONT_UI}" font-size="12" font-weight="700" fill="{th["fg"]}">Update Available</text>')
    parts.append(f'<text x="{ux + 132}" y="{uy + 23}" font-family="{FONT_MONO}" font-size="11" font-weight="700" fill="{th["accent"]}">v1.4.0 → v1.4.1</text>')
    parts.append(f'<text x="{ux + uw - 16}" y="{uy + 24}" text-anchor="middle" font-family="{FONT_UI}" font-size="14" fill="{th["fg_muted"]}">×</text>')
    parts.append(f'<line x1="{ux + 12}" y1="{uy + 34}" x2="{ux + uw - 12}" y2="{uy + 34}" stroke="{th["line"]}" stroke-width="1"/>')

    # Green staged-ready pill inside update popover
    parts.append(f'<rect x="{ux + 12}" y="{uy + 44}" width="{uw - 24}" height="34" rx="6" fill="{th["ok_bg"]}"/>')
    parts.append(f'<text x="{ux + 20}" y="{uy + 58}" font-family="{FONT_UI}" font-size="10" font-weight="600" fill="{th["ok"]}">Verified &amp; smoke-tested — restart now to apply, or it</text>')
    parts.append(f'<text x="{ux + 20}" y="{uy + 71}" font-family="{FONT_UI}" font-size="10" font-weight="600" fill="{th["ok"]}">will apply automatically on next cold start.</text>')

    # Release notes box
    parts.append(f'<rect x="{ux + 12}" y="{uy + 88}" width="{uw - 24}" height="88" rx="6" fill="{th["field"]}" stroke="{th["line"]}" stroke-width="1"/>')
    notes = [
        "What's New in v1.4.1",
        "• Configurable 6-metric Cache Observatory matrix",
        "• boot.mjs cold-start apply & crash auto-rollback",
        "• Supports both Git clone & Standalone installs",
    ]
    ny = uy + 105
    for idx_n, nline in enumerate(notes):
        fw_n = "700" if idx_n == 0 else "400"
        col_n = th["fg"] if idx_n == 0 else th["fg2"]
        parts.append(f'<text x="{ux + 22}" y="{ny}" font-family="{FONT_UI}" font-size="10.2" font-weight="{fw_n}" fill="{col_n}">{esc(nline)}</text>')
        ny += 19

    # Action buttons inside update popover
    by_u = uy + 188
    parts.append(f'<rect x="{ux + 12}" y="{by_u}" width="166" height="28" rx="6" fill="{th["accent"]}"/>')
    parts.append(f'<text x="{ux + 95}" y="{by_u + 18}" text-anchor="middle" font-family="{FONT_UI}" font-size="10.8" font-weight="700" fill="#ffffff">Restart to Apply v1.4.1</text>')
    parts.append(f'<rect x="{ux + 186}" y="{by_u}" width="92" height="28" rx="6" fill="{th["field"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{ux + 232}" y="{by_u + 18}" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg"]}">Skip Version</text>')
    parts.append(f'<rect x="{ux + 286}" y="{by_u}" width="102" height="28" rx="6" fill="{th["field"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{ux + 337}" y="{by_u + 18}" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg"]}">View GitHub</text>')

    # One-time post-update toast preview at bottom of left panel
    toast_y = ly + lh - 68
    parts.append(f'<rect x="{ux}" y="{toast_y}" width="{uw}" height="44" rx="8" fill="{th["accent_bg"]}" stroke="{th["accent_border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{ux + 14}" y="{toast_y + 26}" font-family="{FONT_UI}" font-size="11" font-weight="600" fill="{th["fg"]}">Updated to v1.4.0 (from v1.3.0)</text>')
    parts.append(f'<rect x="{ux + uw - 74}" y="{toast_y + 10}" width="60" height="24" rx="5" fill="{th["surface"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{ux + uw - 44}" y="{toast_y + 25.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" fill="{th["fg"]}">Got it</text>')

    # Right Settings Drawer (474px wide)
    dx, dw = 466, W - 466
    parts.append(f'<rect x="{dx}" y="0" width="{dw}" height="{H}" fill="{th["bg"]}"/>')
    parts.append(f'<line x1="{dx}" y1="0" x2="{dx}" y2="{H}" stroke="{th["border"]}" stroke-width="1"/>')

    # Drawer Header
    parts.append(f'<rect x="{dx + 1}" y="0" width="{dw - 1}" height="44" fill="{th["surface"]}"/>')
    parts.append(f'<line x1="{dx}" y1="44" x2="{W}" y2="44" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{dx + 16}" y="27" font-family="{FONT_UI}" font-size="14" font-weight="700" fill="{th["fg"]}">Settings</text>')
    parts.append(f'<text x="{W - 22}" y="28" text-anchor="middle" font-family="{FONT_UI}" font-size="16" fill="{th["fg_muted"]}">×</text>')

    y = 60
    # Section 1: Language + Polling
    parts.append(f'<text x="{dx + 16}" y="{y}" font-family="{FONT_UI}" font-size="10.2" font-weight="700" fill="{th["fg_muted"]}">LANGUAGE &amp; POLLING</text>')
    y += 7
    parts.append(f'<rect x="{dx + 16}" y="{y}" width="{dw - 32}" height="68" rx="8" fill="{th["surface"]}" stroke="{th["card_border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{dx + 28}" y="{y + 21}" font-family="{FONT_UI}" font-size="11.5" font-weight="600" fill="{th["fg"]}">UI Language</text>')
    parts.append(f'<rect x="{W - 150}" y="{y + 6}" width="122" height="22" rx="6" fill="{th["fill"]}"/>')
    parts.append(f'<rect x="{W - 148}" y="{y + 8}" width="60" height="18" rx="4" fill="{th["surface"]}"/>')
    parts.append(f'<text x="{W - 118}" y="{y + 20.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="10.5" font-weight="600" fill="{th["fg"]}">English</text>')
    parts.append(f'<text x="{W - 58}" y="{y + 20.5}" text-anchor="middle" font-family="{FONT_CJK}" font-size="10.5" fill="{th["fg_muted"]}">中文</text>')
    parts.append(f'<line x1="{dx + 28}" y1="{y + 34}" x2="{W - 28}" y2="{y + 34}" stroke="{th["line"]}" stroke-width="1"/>')
    ar_lbl = "Auto-Refresh Interval"
    parts.append(f'<text x="{dx + 28}" y="{y + 54}" font-family="{FONT_UI}" font-size="11.5" font-weight="600" fill="{th["fg"]}">{ar_lbl}</text>')
    parts.append(svg_help_dot(dx + 28 + text_w(ar_lbl, 11.5, bold=True) + 12, y + 50, th))
    parts.append(f'<rect x="{W - 92}" y="{y + 40}" width="64" height="22" rx="5" fill="{th["field"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{W - 60}" y="{y + 54.5}" text-anchor="middle" font-family="{FONT_MONO}" font-size="10.5" fill="{th["fg"]}">30s ▾</text>')

    # Section 2: Modules & Order (all 7 enabled by default)
    y += 84
    parts.append(f'<text x="{dx + 16}" y="{y}" font-family="{FONT_UI}" font-size="10.2" font-weight="700" fill="{th["fg_muted"]}">MODULES &amp; ORDER (ALL 7 ON BY DEFAULT)</text>')
    y += 7
    modules = [
        ("Live Context", "Auto-compact ceiling & token breakdown", True, False),
        ("Prompt Cache Diagnostics", "Last turn & cumulative hit trajectory", True, False),
        ("Input/Output & Token Flow", "4-bucket token split & TTFT latency", True, False),
        ("Models & API-Eq. Cost", "Model/workspace spend & >200k tiering", True, False),
        ("Calendar Heatmap & Trends", "Active streak, sparkbars & day drill-down", True, False),
        ("Global Cache Observatory", "Configurable 6-metric matrix & detail card", True, True),
        ("Quota & Cycle Budget", "2-decimal anchors & 95% CI calibration", True, False),
    ]
    mod_row_h = 33
    parts.append(f'<rect x="{dx + 16}" y="{y}" width="{dw - 32}" height="{len(modules) * mod_row_h + 6}" rx="8" fill="{th["surface"]}" stroke="{th["card_border"]}" stroke-width="1"/>')
    my = y + 3
    tip_anchor_x = 0.0
    tip_anchor_y = 0.0
    for idx, (mtitle, mdesc, is_on, tip_active) in enumerate(modules):
        if idx > 0:
            parts.append(f'<line x1="{dx + 28}" y1="{my}" x2="{W - 28}" y2="{my}" stroke="{th["line"]}" stroke-width="1"/>')
        parts.append(f'<text x="{dx + 28}" y="{my + 14.5}" font-family="{FONT_UI}" font-size="11.2" font-weight="600" fill="{th["fg"]}">{esc(mtitle)}</text>')
        q_x = dx + 28 + text_w(mtitle, 11.2, bold=True) + 11
        parts.append(svg_help_dot(q_x, my + 10.5, th, active=tip_active))
        if tip_active:
            tip_anchor_x = q_x
            tip_anchor_y = my + 10.5
        parts.append(f'<text x="{dx + 28}" y="{my + 26.5}" font-family="{FONT_UI}" font-size="9.3" fill="{th["fg_muted"]}">{esc(mdesc)}</text>')
        parts.append(f'<text x="{W - 86}" y="{my + 19}" text-anchor="middle" font-family="{FONT_MONO}" font-size="10.5" fill="{th["fg_muted"]}">↑</text>')
        parts.append(f'<text x="{W - 70}" y="{my + 19}" text-anchor="middle" font-family="{FONT_MONO}" font-size="10.5" fill="{th["fg_muted"]}">↓</text>')
        parts.append(svg_switch(W - 56, my + 9, is_on, th))
        my += mod_row_h

    # Section 3: Data Sources & Pricing (compact)
    y += len(modules) * mod_row_h + 22
    parts.append(f'<text x="{dx + 16}" y="{y}" font-family="{FONT_UI}" font-size="10.2" font-weight="700" fill="{th["fg_muted"]}">DATA SOURCES &amp; 3-TIER PRICING</text>')
    y += 7
    parts.append(f'<rect x="{dx + 16}" y="{y}" width="{dw - 32}" height="96" rx="8" fill="{th["surface"]}" stroke="{th["card_border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{dx + 28}" y="{y + 20}" font-family="{FONT_UI}" font-size="11.2" font-weight="600" fill="{th["fg"]}">Antigravity Desktop &amp; CLI</text>')
    parts.append(f'<text x="{dx + 28}" y="{y + 33}" font-family="{FONT_MONO}" font-size="9.3" fill="{th["fg_muted"]}">Read-only SQLite scan (Desktop 18 DBs · CLI 42 DBs)</text>')
    parts.append(svg_switch(W - 56, y + 12, True, th))
    parts.append(f'<line x1="{dx + 28}" y1="{y + 44}" x2="{W - 28}" y2="{y + 44}" stroke="{th["line"]}" stroke-width="1"/>')
    parts.append(f'<text x="{dx + 28}" y="{y + 62}" font-family="{FONT_UI}" font-size="11.2" font-weight="600" fill="{th["fg"]}">Auto-Sync Remote Pricing (LiteLLM / OpenRouter)</text>')
    parts.append(svg_switch(W - 56, y + 51, False, th))
    parts.append(f'<text x="{dx + 28}" y="{y + 82}" font-family="{FONT_UI}" font-size="9.5" fill="{th["fg_muted"]}">Bundled defaults + user overrides · optional 24h remote sync</text>')

    # Section 4: Version & Auto-Update (NEW v1.4.0)
    y += 114
    parts.append(f'<text x="{dx + 16}" y="{y}" font-family="{FONT_UI}" font-size="10.2" font-weight="700" fill="{th["fg_muted"]}">VERSION &amp; AUTO-UPDATE</text>')
    pver, _ = svg_pill(W - 150, y - 13, "v1.4.0 · Git Install", th["field"], th["fg2"], font_size=9.5, h=18, pad_x=8, mono=True)
    parts.append(pver)
    y += 8
    upd_h = H - y - 16
    parts.append(f'<rect x="{dx + 16}" y="{y}" width="{dw - 32}" height="{upd_h}" rx="8" fill="{th["surface"]}" stroke="{th["accent_border"]}" stroke-width="1.1"/>')

    # Update Policy segmented control
    up_lbl = "Update Policy"
    parts.append(f'<text x="{dx + 28}" y="{y + 22}" font-family="{FONT_UI}" font-size="11.5" font-weight="600" fill="{th["fg"]}">{up_lbl}</text>')
    parts.append(svg_help_dot(dx + 28 + text_w(up_lbl, 11.5, bold=True) + 11, y + 18, th))
    parts.append(f'<rect x="{W - 196}" y="{y + 7}" width="168" height="22" rx="6" fill="{th["fill"]}"/>')
    parts.append(f'<rect x="{W - 194}" y="{y + 9}" width="54" height="18" rx="4" fill="{th["surface"]}"/>')
    parts.append(f'<text x="{W - 167}" y="{y + 21.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="10.2" font-weight="700" fill="{th["fg"]}">Auto</text>')
    parts.append(f'<text x="{W - 112}" y="{y + 21.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="10.2" fill="{th["fg_muted"]}">Notify</text>')
    parts.append(f'<text x="{W - 56}" y="{y + 21.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="10.2" fill="{th["fg_muted"]}">Off</text>')

    parts.append(f'<line x1="{dx + 28}" y1="{y + 37}" x2="{W - 28}" y2="{y + 37}" stroke="{th["line"]}" stroke-width="1"/>')

    # Status + Check Now + Restart to Apply
    parts.append(f'<text x="{dx + 28}" y="{y + 57}" font-family="{FONT_MONO}" font-size="10.5" font-weight="700" fill="{th["accent"]}">v1.4.1</text>')
    parts.append(f'<text x="{dx + 74}" y="{y + 57}" font-family="{FONT_UI}" font-size="10.2" fill="{th["fg_muted"]}">· Checked 2m ago</text>')
    parts.append(f'<rect x="{W - 236}" y="{y + 42}" width="78" height="23" rx="5" fill="{th["field"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{W - 197}" y="{y + 57}" text-anchor="middle" font-family="{FONT_UI}" font-size="10" fill="{th["fg"]}">Check Now</text>')
    parts.append(f'<rect x="{W - 152}" y="{y + 42}" width="124" height="23" rx="5" fill="{th["accent"]}"/>')
    parts.append(f'<text x="{W - 90}" y="{y + 57}" text-anchor="middle" font-family="{FONT_UI}" font-size="10" font-weight="700" fill="#ffffff">Restart to Apply</text>')

    # Verified note + Rollback button
    parts.append(f'<text x="{dx + 28}" y="{y + 82}" font-family="{FONT_UI}" font-size="9.8" fill="{th["ok"]}">Verified &amp; smoke-tested — ready to apply on restart</text>')
    parts.append(f'<line x1="{dx + 28}" y1="{y + 94}" x2="{W - 28}" y2="{y + 94}" stroke="{th["line"]}" stroke-width="1"/>')
    parts.append(f'<text x="{dx + 28}" y="{y + 114}" font-family="{FONT_UI}" font-size="9.8" fill="{th["fg_muted"]}">Crash-safe cold-start apply via boot.mjs</text>')
    parts.append(f'<rect x="{W - 152}" y="{y + 100}" width="124" height="22" rx="5" fill="{th["field"]}" stroke="{th["border"]}" stroke-width="1"/>')
    parts.append(f'<text x="{W - 90}" y="{y + 114.5}" text-anchor="middle" font-family="{FONT_UI}" font-size="10" fill="{th["fg"]}">Rollback to v1.3.0</text>')

    # Floating `?` Help Tooltip Callout on lower-left linking to Global Cache Observatory `?`
    tx, ty, tw_tip, th_tip = ux, 360, uw, 114
    parts.append(f'<rect x="{tx}" y="{ty}" width="{tw_tip}" height="{th_tip}" rx="9" fill="{th["surface"]}" stroke="{th["accent"]}" stroke-width="1.4"/>')
    mid_x = dx - 8
    sep_y = tip_anchor_y - 10.5
    parts.append(
        f'<path d="M {tx + tw_tip} {ty + th_tip/2:.1f} L {mid_x} {ty + th_tip/2:.1f} L {mid_x} {sep_y:.1f} L {tip_anchor_x:.1f} {sep_y:.1f} L {tip_anchor_x:.1f} {tip_anchor_y - 8:.1f}" '
        f'fill="none" stroke="{th["accent"]}" stroke-width="1.3" stroke-dasharray="4,3"/>'
    )
    parts.append(f'<circle cx="{tip_anchor_x:.1f}" cy="{tip_anchor_y - 8:.1f}" r="2.6" fill="{th["accent"]}"/>')
    parts.append(f'<text x="{tx + 14}" y="{ty + 21}" font-family="{FONT_UI}" font-size="11" font-weight="700" fill="{th["accent"]}">Global Cache Observatory — Module Help</text>')
    tip_lines = [
        ("What it shows:", "6-metric Idle-Gap matrix, scatter &amp; anomalies."),
        ("When to enable:", "Enabled by default; toggle off anytime."),
        ("Scan scope:", "Consecutive follow-up turns (read-only)."),
    ]
    tly = ty + 42
    for k_s, v_s in tip_lines:
        parts.append(
            f'<text x="{tx + 14}" y="{tly}" font-family="{FONT_UI}" font-size="10.2" fill="{th["fg"]}">'
            f'<tspan font-weight="700">{k_s}</tspan> <tspan fill="{th["fg2"]}">{v_s}</tspan></text>'
        )
        tly += 20

    parts.append("</svg>")
    return "\n".join(parts)


def render_settings_drawer() -> Path:
    svg_str = build_settings_drawer_svg()
    img = composite_panels(
        1000,
        770,
        [(svg_str, 30, 30, 14)],
        scale=2,
        top_rgb=(17, 20, 28),
        bot_rgb=(11, 13, 19),
    )
    out = OUT_DIR / "settings-drawer.png"
    img.save(out, optimize=True)
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = [
        render_hero_dual_theme(),
        render_cache_observatory(),
        render_cost_calendar(),
        render_quota_budget(),
        render_settings_drawer(),
    ]
    for p in outputs:
        with Image.open(p) as im:
            print(f"[rendered] {p.relative_to(ROOT_DIR)} ({im.width}x{im.height}, {p.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
