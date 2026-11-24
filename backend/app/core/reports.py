"""PDF report generation for a single BCA scenario and for a two-BCA comparison.

Reports are rendered server-side with ReportLab so they look identical for every viewer and
can be produced from the API without a browser. Charts are drawn with simple ReportLab
graphics primitives to keep full control over styling.
"""

from __future__ import annotations

import io
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, Sequence
from xml.sax.saxutils import escape

from reportlab.graphics.shapes import Drawing, Line, Polygon, PolyLine, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.platypus import (
    CondPageBreak,
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.models import (
    BCAComparisonResult,
    BCADetail,
    DeterministicMetrics,
    InitiativeDetail,
    SimulationResult,
)

# ---------------------------------------------------------------------------
# Palette & typography
# ---------------------------------------------------------------------------

INK = colors.HexColor("#1f2433")
BODY = colors.HexColor("#3a4152")
MUTED = colors.HexColor("#6b7385")
RULE = colors.HexColor("#d9dde6")
SUBTLE = colors.HexColor("#f3f5f9")
ACCENT = colors.HexColor("#475587")
COLOR_A = colors.HexColor("#475587")
COLOR_B = colors.HexColor("#2f8a66")
BENEFIT = colors.HexColor("#2f8a66")
COST = colors.HexColor("#c0564b")
WARN_BG = colors.HexColor("#fdf6e3")
WARN_INK = colors.HexColor("#8a6414")

PAGE_W, PAGE_H = LETTER
MARGIN = 0.7 * inch
CONTENT_W = PAGE_W - 2 * MARGIN

FONT = "Helvetica"
FONT_BOLD = "Helvetica-Bold"

STYLES = {
    "eyebrow": ParagraphStyle("eyebrow", fontName=FONT_BOLD, fontSize=8, leading=10, textColor=ACCENT, spaceAfter=4),
    "title": ParagraphStyle("title", fontName=FONT_BOLD, fontSize=21, leading=25, textColor=INK, spaceAfter=4),
    "subtitle": ParagraphStyle("subtitle", fontName=FONT, fontSize=11.5, leading=15, textColor=BODY, spaceAfter=2),
    "meta": ParagraphStyle("meta", fontName=FONT, fontSize=8.5, leading=11, textColor=MUTED),
    "h2": ParagraphStyle("h2", fontName=FONT_BOLD, fontSize=13, leading=16, textColor=INK, spaceBefore=14, spaceAfter=6),
    "h3": ParagraphStyle("h3", fontName=FONT_BOLD, fontSize=10, leading=13, textColor=INK, spaceBefore=8, spaceAfter=4),
    "body": ParagraphStyle("body", fontName=FONT, fontSize=9.5, leading=13.5, textColor=BODY, spaceAfter=6),
    "small": ParagraphStyle("small", fontName=FONT, fontSize=8, leading=10.5, textColor=MUTED, spaceAfter=4),
    "cell": ParagraphStyle("cell", fontName=FONT, fontSize=8, leading=10, textColor=BODY),
    "cell_r": ParagraphStyle("cell_r", fontName=FONT, fontSize=8, leading=10, textColor=BODY, alignment=TA_RIGHT),
    "cell_b": ParagraphStyle("cell_b", fontName=FONT_BOLD, fontSize=8, leading=10, textColor=INK),
    "head": ParagraphStyle("head", fontName=FONT_BOLD, fontSize=7.5, leading=9.5, textColor=MUTED),
    "head_r": ParagraphStyle("head_r", fontName=FONT_BOLD, fontSize=7.5, leading=9.5, textColor=MUTED, alignment=TA_RIGHT),
    "kpi_value": ParagraphStyle("kpi_value", fontName=FONT_BOLD, fontSize=15, leading=18, textColor=INK),
    "kpi_label": ParagraphStyle("kpi_label", fontName=FONT, fontSize=7.5, leading=9.5, textColor=MUTED),
    "kpi_note": ParagraphStyle("kpi_note", fontName=FONT, fontSize=7.5, leading=9.5, textColor=BODY),
    "callout": ParagraphStyle("callout", fontName=FONT, fontSize=8.5, leading=11.5, textColor=WARN_INK, alignment=TA_LEFT),
}


# ---------------------------------------------------------------------------
# Formatting helpers (mirror frontend/src/utils/format.ts)
# ---------------------------------------------------------------------------


def _finite(v: float | None) -> bool:
    return v is not None and isinstance(v, (int, float)) and math.isfinite(v)


def fmt_money(v: float | None) -> str:
    if not _finite(v):
        return "-"
    sign = "-" if v < 0 else ""
    return f"{sign}${abs(round(v)):,.0f}"


def fmt_compact(v: float | None) -> str:
    if not _finite(v):
        return "-"
    sign = "-" if v < 0 else ""
    a = abs(v)
    if a >= 1e9:
        return f"{sign}${a / 1e9:.2f}B"
    if a >= 1e6:
        return f"{sign}${a / 1e6:.2f}M"
    if a >= 1e4:
        return f"{sign}${a / 1e3:.1f}K"
    if a >= 1e3:
        return f"{sign}${round(a):,.0f}"
    return f"{sign}${a:.0f}"


def fmt_axis(v: float | None) -> str:
    """Compact currency for axis ticks, without trailing zeros ($500K, $1.5M)."""
    text = fmt_compact(v)
    m = re.match(r"^(-?\$)(\d+\.\d+)([KMB])$", text)
    if not m:
        return text
    return f"{m.group(1)}{m.group(2).rstrip('0').rstrip('.')}{m.group(3)}"


def fmt_signed_compact(v: float | None) -> str:
    if not _finite(v):
        return "-"
    return ("+" if v > 0 else "") + fmt_compact(v)


def fmt_pct(v: float | None, digits: int = 1) -> str:
    return "-" if not _finite(v) else f"{v * 100:.{digits}f}%"


def fmt_ratio(v: float | None) -> str:
    return "N/A" if not _finite(v) else f"{v:.2f}x"


def fmt_payback(v: float | None) -> str:
    if not _finite(v):
        return "No payback"
    if v == 0:
        return "Immediate"
    return f"{v:.1f} yrs"


def year_label(year: int, cost_start_year: int | None) -> str:
    return f"Y{year}" if cost_start_year is None else f"Y{year} ({cost_start_year + year - 1})"


def year_short(year: int, cost_start_year: int | None) -> str:
    return f"Y{year}" if cost_start_year is None else str(cost_start_year + year - 1)


def _fmt_ts(iso: str | None) -> str:
    if not iso:
        return "-"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return iso
    return dt.strftime("%b %d, %Y %H:%M UTC")


def _p(text: str, style: str = "body") -> Paragraph:
    return Paragraph(text, STYLES[style])


def _e(text: str | None) -> str:
    """Escape user text for Paragraph markup."""
    return escape(text or "")


def report_filename(*parts: str) -> str:
    slug = "-".join(re.sub(r"[^a-z0-9]+", "-", p.lower()).strip("-") for p in parts if p)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")[:120] or "report"
    return f"{slug}-{datetime.now(timezone.utc).strftime('%Y%m%d')}.pdf"


# ---------------------------------------------------------------------------
# Page template
# ---------------------------------------------------------------------------


def _numbered_canvas_factory(footer_left: str):
    class NumberedCanvas(pdf_canvas.Canvas):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._saved_states: list[dict] = []

        def showPage(self):  # noqa: N802 (ReportLab API)
            self._saved_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_states)
            for state in self._saved_states:
                self.__dict__.update(state)
                self._draw_chrome(total)
                super().showPage()
            super().save()

        def _draw_chrome(self, total: int) -> None:
            self.saveState()
            self.setStrokeColor(RULE)
            self.setLineWidth(0.5)
            self.line(MARGIN, 0.55 * inch, PAGE_W - MARGIN, 0.55 * inch)
            self.setFont(FONT, 7.5)
            self.setFillColor(MUTED)
            left = footer_left
            max_w = CONTENT_W - 70
            while left and stringWidth(left, FONT, 7.5) > max_w:
                left = left[:-2]
            if left != footer_left:
                left = left.rstrip() + "..."
            self.drawString(MARGIN, 0.4 * inch, left)
            self.drawRightString(PAGE_W - MARGIN, 0.4 * inch, f"Page {self._pageNumber} of {total}")
            self.restoreState()

    return NumberedCanvas


def _build_pdf(flowables: list, *, title: str, footer: str, author: str = "") -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=LETTER,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=0.65 * inch,
        bottomMargin=0.8 * inch,
        title=title,
        author=author or "ValueStream BCA",
        creator="ValueStream BCA",
    )
    doc.build(flowables, canvasmaker=_numbered_canvas_factory(footer))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Table helpers
# ---------------------------------------------------------------------------


def _data_table(
    header: Sequence[str],
    rows: Sequence[Sequence[object]],
    col_widths: Sequence[float],
    *,
    align_right_from: int = 1,
    bold_last_row: bool = False,
    row_colors: dict[int, colors.Color] | None = None,
) -> Table:
    """A clean zebra table. Cells may be str (escaped) or prebuilt Paragraphs."""

    def cell(value: object, col: int, *, is_head: bool = False, bold: bool = False) -> object:
        if not isinstance(value, str):
            return value
        right = col >= align_right_from
        if is_head:
            return Paragraph(_e(value), STYLES["head_r" if right else "head"])
        style = "cell_r" if right else ("cell_b" if bold and col == 0 else "cell")
        text = _e(value)
        if bold:
            text = f"<b>{text}</b>"
        return Paragraph(text, STYLES[style])

    data = [[cell(h, i, is_head=True) for i, h in enumerate(header)]]
    for r_idx, row in enumerate(rows):
        bold = bold_last_row and r_idx == len(rows) - 1
        data.append([cell(v, i, bold=bold) for i, v in enumerate(row)])

    t = Table(data, colWidths=list(col_widths), repeatRows=1)
    cmds: list = [
        ("LINEBELOW", (0, 0), (-1, 0), 0.75, INK),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            cmds.append(("BACKGROUND", (0, i), (-1, i), SUBTLE))
    if bold_last_row and rows:
        cmds.append(("LINEABOVE", (0, len(data) - 1), (-1, len(data) - 1), 0.75, INK))
    for idx, color in (row_colors or {}).items():
        cmds.append(("TEXTCOLOR", (0, idx + 1), (-1, idx + 1), color))
    t.setStyle(TableStyle(cmds))
    return t


def _kpi_grid(tiles: Sequence[tuple[str, str, str]], cols: int = 4) -> Table:
    """Grid of KPI tiles: (label, value, note)."""
    cells = []
    for label, value, note in tiles:
        cells.append(
            [
                Paragraph(_e(label).upper(), STYLES["kpi_label"]),
                Paragraph(_e(value), STYLES["kpi_value"]),
                Paragraph(_e(note), STYLES["kpi_note"]) if note else Spacer(1, 1),
            ]
        )
    while len(cells) % cols:
        cells.append("")
    rows = [cells[i : i + cols] for i in range(0, len(cells), cols)]
    gap = 6
    w = (CONTENT_W - gap * (cols - 1)) / cols
    # Interleave spacer columns for gaps between tiles.
    data = []
    widths: list[float] = []
    for c in range(cols):
        widths.append(w)
        if c < cols - 1:
            widths.append(gap)
    for r in rows:
        line: list = []
        for c, v in enumerate(r):
            line.append(v)
            if c < cols - 1:
                line.append("")
        data.append(line)
    t = Table(data, colWidths=widths)
    cmds: list = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]
    for r_idx, r in enumerate(rows):
        for c, v in enumerate(r):
            if v != "":
                col = c * 2
                cmds.append(("BACKGROUND", (col, r_idx), (col, r_idx), SUBTLE))
                cmds.append(("LINEBEFORE", (col, r_idx), (col, r_idx), 2, ACCENT))
    # Vertical gap between rows.
    t.setStyle(TableStyle(cmds))
    return t


def _callout(text: str) -> Table:
    t = Table([[Paragraph(text, STYLES["callout"])]], colWidths=[CONTENT_W])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), WARN_BG),
                ("LINEBEFORE", (0, 0), (0, -1), 2, WARN_INK),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return t


def _section(title: str, *flowables, keep: bool = True) -> list:
    head = _p(_e(title), "h2")
    if keep:
        return [KeepTogether([head, *flowables])]
    return [CondPageBreak(1.6 * inch), head, *flowables]


# ---------------------------------------------------------------------------
# Chart helpers
# ---------------------------------------------------------------------------


def _nice_ticks(lo: float, hi: float, target: int = 5) -> list[float]:
    if not (math.isfinite(lo) and math.isfinite(hi)):
        return [0.0]
    if hi == lo:
        pad = abs(hi) * 0.1 or 1.0
        lo, hi = lo - pad, hi + pad
    raw = (hi - lo) / max(target, 1)
    mag = 10 ** math.floor(math.log10(raw))
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    start = math.floor(lo / step) * step
    ticks = []
    v = start
    while v <= hi + step * 0.5:
        ticks.append(round(v, 10))
        v += step
        if len(ticks) > 20:
            break
    if ticks[-1] < hi:
        ticks.append(ticks[-1] + step)
    return ticks


@dataclass
class _Frame:
    x0: float
    y0: float
    w: float
    h: float
    lo: float
    hi: float

    def y(self, v: float) -> float:
        return self.y0 + (v - self.lo) / (self.hi - self.lo) * self.h


def _legend(d: Drawing, items: Iterable[tuple[str, colors.Color, str]], x: float, y: float) -> None:
    """Draw a horizontal legend. style is 'box' or 'line' or 'dash'."""
    cx = x
    for label, color, style in items:
        if style == "box":
            d.add(Rect(cx, y - 1, 8, 8, fillColor=color, strokeColor=None))
        else:
            d.add(
                Line(
                    cx,
                    y + 3,
                    cx + 12,
                    y + 3,
                    strokeColor=color,
                    strokeWidth=1.8,
                    strokeDashArray=[3, 2] if style == "dash" else None,
                )
            )
        tx = cx + (11 if style == "box" else 15)
        d.add(String(tx, y, label, fontName=FONT, fontSize=7.5, fillColor=BODY))
        cx = tx + stringWidth(label, FONT, 7.5) + 14


def _value_axis(d: Drawing, f: _Frame, ticks: list[float], fmt=fmt_axis) -> None:
    for t in ticks:
        yy = f.y(t)
        d.add(
            Line(
                f.x0,
                yy,
                f.x0 + f.w,
                yy,
                strokeColor=INK if t == 0 else RULE,
                strokeWidth=0.8 if t == 0 else 0.4,
            )
        )
        d.add(String(f.x0 - 4, yy - 2.5, fmt(t), fontName=FONT, fontSize=7, fillColor=MUTED, textAnchor="end"))


def bar_line_chart(
    categories: Sequence[str],
    bars: Sequence[tuple[str, Sequence[float], colors.Color]],
    lines: Sequence[tuple[str, Sequence[float], colors.Color, str]] = (),
    *,
    width: float = CONTENT_W,
    height: float = 2.4 * inch,
) -> Drawing:
    """Grouped vertical bars per category with optional overlaid lines on the same axis."""
    d = Drawing(width, height)
    values = [v for _, vs, _ in bars for v in vs] + [v for _, vs, _, _ in lines for v in vs]
    values = [v for v in values if _finite(v)] or [0.0]
    lo, hi = min(0.0, min(values)), max(0.0, max(values))
    ticks = _nice_ticks(lo, hi)
    f = _Frame(52, 30, width - 60, height - 52, ticks[0], ticks[-1])
    _value_axis(d, f, ticks)

    n = max(len(categories), 1)
    slot = f.w / n
    group_w = slot * 0.72
    bar_w = group_w / max(len(bars), 1)
    label_every = max(1, math.ceil(n / 16))
    for i, cat in enumerate(categories):
        gx = f.x0 + i * slot + (slot - group_w) / 2
        for j, (_, vs, color) in enumerate(bars):
            v = vs[i] if i < len(vs) and _finite(vs[i]) else 0.0
            y1, y2 = f.y(0), f.y(v)
            d.add(
                Rect(gx + j * bar_w, min(y1, y2), max(bar_w - 1, 0.5), abs(y2 - y1), fillColor=color, strokeColor=None)
            )
        if i % label_every == 0:
            d.add(
                String(
                    f.x0 + i * slot + slot / 2,
                    f.y0 - 11,
                    cat,
                    fontName=FONT,
                    fontSize=7,
                    fillColor=MUTED,
                    textAnchor="middle",
                )
            )
    for _, vs, color, style in lines:
        pts: list[float] = []
        for i, v in enumerate(vs):
            if _finite(v):
                pts += [f.x0 + i * slot + slot / 2, f.y(v)]
        if len(pts) >= 4:
            d.add(
                PolyLine(
                    pts,
                    strokeColor=color,
                    strokeWidth=1.8,
                    strokeDashArray=[4, 2] if style == "dash" else None,
                )
            )
        for k in range(0, len(pts), 2):
            d.add(Rect(pts[k] - 1.5, pts[k + 1] - 1.5, 3, 3, fillColor=color, strokeColor=None))

    legend = [(lbl, c, "box") for lbl, _, c in bars] + [(lbl, c, style) for lbl, _, c, style in lines]
    _legend(d, legend, f.x0, height - 12)
    return d


def distribution_chart(
    series: Sequence[tuple[str, Sequence[float], Sequence[float], colors.Color]],
    markers: Sequence[tuple[float, str, colors.Color]] = (),
    *,
    width: float = CONTENT_W,
    height: float = 2.2 * inch,
    bars: bool = False,
    sign_colors: bool = False,
) -> Drawing:
    """Density curves (or bars) over a numeric x axis. series = (label, xs, ys, color)."""
    d = Drawing(width, height)
    xs_all = [x for _, xs, _, _ in series for x in xs if _finite(x)]
    ys_all = [y for _, _, ys, _ in series for y in ys if _finite(y)]
    if not xs_all or not ys_all:
        d.add(String(width / 2, height / 2, "No distribution data", fontName=FONT, fontSize=8, fillColor=MUTED, textAnchor="middle"))
        return d
    x_ticks = _nice_ticks(min(xs_all), max(xs_all), 6)
    xlo, xhi = x_ticks[0], x_ticks[-1]
    left, bottom, top_pad = 14, 28, 22
    plot_w = width - left - 10
    plot_h = height - bottom - top_pad
    ymax = max(ys_all) * 1.08 or 1.0

    def px(x: float) -> float:
        return left + (x - xlo) / (xhi - xlo) * plot_w

    def py(y: float) -> float:
        return bottom + y / ymax * plot_h

    d.add(Line(left, bottom, left + plot_w, bottom, strokeColor=INK, strokeWidth=0.8))
    for t in x_ticks:
        d.add(Line(px(t), bottom, px(t), bottom - 3, strokeColor=MUTED, strokeWidth=0.5))
        d.add(String(px(t), bottom - 12, fmt_axis(t), fontName=FONT, fontSize=7, fillColor=MUTED, textAnchor="middle"))
    if xlo < 0 < xhi:
        d.add(Line(px(0), bottom, px(0), bottom + plot_h, strokeColor=MUTED, strokeWidth=0.6, strokeDashArray=[2, 2]))

    for _, xs, ys, color in series:
        pairs = [(x, y) for x, y in zip(xs, ys) if _finite(x) and _finite(y)]
        if not pairs:
            continue
        if bars:
            step = (pairs[1][0] - pairs[0][0]) if len(pairs) > 1 else (xhi - xlo) / 30
            bw = abs(px(pairs[0][0] + step) - px(pairs[0][0]))
            for x, y in pairs:
                c = (COST if x < 0 else BENEFIT) if sign_colors else color
                d.add(Rect(px(x) - bw / 2, bottom, max(bw - 0.6, 0.4), py(y) - bottom, fillColor=c, strokeColor=None))
        else:
            pts = [px(pairs[0][0]), bottom]
            for x, y in pairs:
                pts += [px(x), py(y)]
            pts += [px(pairs[-1][0]), bottom]
            fill = colors.Color(color.red, color.green, color.blue, alpha=0.18)
            d.add(Polygon(pts, fillColor=fill, strokeColor=None))
            d.add(PolyLine(pts[2:-2], strokeColor=color, strokeWidth=1.5))

    for x, label, color in markers:
        if not _finite(x) or not (xlo <= x <= xhi):
            continue
        d.add(Line(px(x), bottom, px(x), bottom + plot_h, strokeColor=color, strokeWidth=1, strokeDashArray=[3, 2]))
        d.add(String(px(x) + 2, bottom + plot_h - 8, label, fontName=FONT, fontSize=6.5, fillColor=color))

    legend = [(lbl, c, "box" if bars else "line") for lbl, _, _, c in series if lbl]
    if sign_colors:
        legend = [("Below zero", COST, "box"), ("Above zero", BENEFIT, "box")]
    _legend(d, legend, left, height - 12)
    return d


def fan_chart(
    years: Sequence[str],
    p10: Sequence[float],
    p25: Sequence[float],
    p50: Sequence[float],
    p75: Sequence[float],
    p90: Sequence[float],
    *,
    width: float = CONTENT_W,
    height: float = 2.2 * inch,
) -> Drawing:
    d = Drawing(width, height)
    vals = [v for seq in (p10, p90) for v in seq if _finite(v)] or [0.0]
    ticks = _nice_ticks(min(0.0, min(vals)), max(0.0, max(vals)))
    f = _Frame(52, 30, width - 60, height - 52, ticks[0], ticks[-1])
    _value_axis(d, f, ticks)
    n = len(years)
    if n == 0:
        return d

    def x(i: int) -> float:
        return f.x0 + (i / (n - 1) * f.w if n > 1 else f.w / 2)

    def band(lo_s: Sequence[float], hi_s: Sequence[float], alpha: float) -> None:
        pts = [c for i in range(n) for c in (x(i), f.y(hi_s[i]))]
        pts += [c for i in reversed(range(n)) for c in (x(i), f.y(lo_s[i]))]
        d.add(Polygon(pts, fillColor=colors.Color(ACCENT.red, ACCENT.green, ACCENT.blue, alpha=alpha), strokeColor=None))

    band(p10, p90, 0.14)
    band(p25, p75, 0.26)
    d.add(PolyLine([c for i in range(n) for c in (x(i), f.y(p50[i]))], strokeColor=ACCENT, strokeWidth=1.8))
    label_every = max(1, math.ceil(n / 16))
    for i, yl in enumerate(years):
        if i % label_every == 0:
            d.add(String(x(i), f.y0 - 11, yl, fontName=FONT, fontSize=7, fillColor=MUTED, textAnchor="middle"))
    shade_light = colors.Color(ACCENT.red, ACCENT.green, ACCENT.blue, alpha=0.2)
    shade_dark = colors.Color(ACCENT.red, ACCENT.green, ACCENT.blue, alpha=0.4)
    _legend(d, [("P50", ACCENT, "line"), ("P25-P75", shade_dark, "box"), ("P10-P90", shade_light, "box")], f.x0, height - 12)
    return d


def hbar_chart(
    labels: Sequence[str],
    series: Sequence[tuple[str, Sequence[float], colors.Color]],
    *,
    width: float = CONTENT_W,
    row_h: float = 16,
    fmt=fmt_axis,
) -> Drawing:
    """Horizontal grouped bars, one row per label (value streams, drivers)."""
    n = len(labels)
    k = max(len(series), 1)
    label_w = min(170, max((stringWidth(lbl, FONT, 7.5) for lbl in labels), default=40) + 8)
    height = n * row_h * (1 if k == 1 else 1.25) + 44
    d = Drawing(width, height)
    vals = [v for _, vs, _ in series for v in vs if _finite(v)] or [0.0]
    ticks = _nice_ticks(min(0.0, min(vals)), max(0.0, max(vals)), 5)
    lo, hi = ticks[0], ticks[-1]
    x0 = label_w + 4
    plot_w = width - x0 - 10
    top = height - 22
    bottom = 22

    def px(v: float) -> float:
        return x0 + (v - lo) / (hi - lo) * plot_w

    for t in ticks:
        d.add(Line(px(t), bottom, px(t), top, strokeColor=INK if t == 0 else RULE, strokeWidth=0.8 if t == 0 else 0.4))
        d.add(String(px(t), bottom - 11, fmt(t), fontName=FONT, fontSize=7, fillColor=MUTED, textAnchor="middle"))
    slot = (top - bottom) / max(n, 1)
    bar_h = min(slot * 0.72 / k, 11)
    for i, lbl in enumerate(labels):
        cy = top - (i + 0.5) * slot
        text = lbl
        while text and stringWidth(text, FONT, 7.5) > label_w - 4:
            text = text[:-1]
        if text != lbl:
            text = text[:-1] + "..."
        d.add(String(label_w, cy - 2.5, text, fontName=FONT, fontSize=7.5, fillColor=BODY, textAnchor="end"))
        start = cy + bar_h * k / 2
        for j, (_, vs, color) in enumerate(series):
            v = vs[i] if i < len(vs) and _finite(vs[i]) else 0.0
            y = start - (j + 1) * bar_h
            d.add(Rect(min(px(0), px(v)), y + 0.5, abs(px(v) - px(0)), bar_h - 1, fillColor=color, strokeColor=None))
    if k > 1 or series[0][0]:
        _legend(d, [(lbl, c, "box") for lbl, _, c in series if lbl], x0, height - 12)
    return d


# ---------------------------------------------------------------------------
# Shared content builders
# ---------------------------------------------------------------------------


def _is_default_run(sim: SimulationResult, bca: BCADetail) -> bool:
    return (
        abs(sim.discount_rate - bca.discount_rate) < 1e-9
        and sim.horizon_years == bca.horizon_years
        and sim.benefit_scale == 1.0
        and sim.cost_scale == 1.0
    )


def _run_is_stale(sim: SimulationResult, bca: BCADetail) -> bool:
    """True when a default-settings run no longer matches the scenario's current inputs."""
    if not _is_default_run(sim, bca):
        return False
    cur, old = bca.deterministic, sim.deterministic
    tol = max(1.0, abs(cur.npv) * 1e-6)
    return abs(cur.npv - old.npv) > tol or abs(cur.pv_costs - old.pv_costs) > tol


def _whatif_notes(sim: SimulationResult, bca: BCADetail) -> list[str]:
    notes = []
    if abs(sim.discount_rate - bca.discount_rate) >= 1e-9:
        notes.append(f"discount rate {fmt_pct(sim.discount_rate, 2)} (scenario uses {fmt_pct(bca.discount_rate, 2)})")
    if sim.horizon_years != bca.horizon_years:
        notes.append(f"horizon {sim.horizon_years} yrs (scenario uses {bca.horizon_years})")
    if sim.benefit_scale != 1.0:
        notes.append(f"benefits scaled x{sim.benefit_scale:.2f}")
    if sim.cost_scale != 1.0:
        notes.append(f"costs scaled x{sim.cost_scale:.2f}")
    if sim.uncertainty_scale != 1.0:
        notes.append(f"uncertainty spread x{sim.uncertainty_scale:.2f}")
    return notes


def _title_block(eyebrow: str, title: str, subtitle: str, meta: Sequence[str]) -> list:
    out = [
        _p(_e(eyebrow.upper()), "eyebrow"),
        _p(_e(title), "title"),
        _p(_e(subtitle), "subtitle"),
        _p(" &nbsp;&middot;&nbsp; ".join(_e(m) for m in meta if m), "meta"),
        Spacer(1, 6),
    ]
    rule = Table([[""]], colWidths=[CONTENT_W], rowHeights=[2])
    rule.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 1.2, ACCENT)]))
    out += [rule, Spacer(1, 8)]
    return out


def _cash_flow_section(det: DeterministicMetrics, cost_start_year: int | None) -> list:
    rows = det.yearly_cash_flows
    if not rows:
        return []
    cats = [year_short(r.year, cost_start_year) for r in rows]
    chart = bar_line_chart(
        cats,
        [
            ("PV benefits", [r.pv_benefit for r in rows], BENEFIT),
            ("PV costs", [-r.pv_cost for r in rows], COST),
        ],
        [("Cumulative net PV", [r.cumulative_net_pv for r in rows], INK, "line")],
    )
    table_rows = [
        [
            year_label(r.year, cost_start_year),
            fmt_money(r.undiscounted_benefit),
            fmt_money(r.undiscounted_cost),
            fmt_money(r.net_undiscounted),
            fmt_money(r.net_pv),
            fmt_money(r.cumulative_net_pv),
        ]
        for r in rows
    ]
    table_rows.append(
        [
            "Total",
            fmt_money(sum(r.undiscounted_benefit for r in rows)),
            fmt_money(sum(r.undiscounted_cost for r in rows)),
            fmt_money(sum(r.net_undiscounted for r in rows)),
            fmt_money(det.npv),
            "",
        ]
    )
    w = CONTENT_W
    table = _data_table(
        ["Year", "Benefits", "Costs", "Net", "Net PV", "Cumulative net PV"],
        table_rows,
        [w * 0.18, w * 0.164, w * 0.164, w * 0.164, w * 0.164, w * 0.164],
        bold_last_row=True,
    )
    return [
        *_section(
            "Cash flow by year",
            _p("Discounted benefits and costs per year, with the cumulative net present value.", "small"),
            chart,
        ),
        Spacer(1, 6),
        table,
    ]


def _value_stream_rows(det: DeterministicMetrics, sim: SimulationResult | None) -> list[list[str]]:
    sim_by_vs = {v.value_stream: v for v in (sim.monte_carlo.value_streams if sim else [])}
    out = []
    for vs in sorted(det.value_streams, key=lambda v: -v.npv):
        s = sim_by_vs.get(vs.value_stream)
        out.append(
            [
                vs.value_stream or "(unassigned)",
                str(vs.item_count),
                fmt_money(vs.pv_benefits),
                fmt_money(vs.pv_costs),
                fmt_money(vs.npv),
                fmt_ratio(vs.bcr),
                fmt_compact(s.sim_npv_p50) if s and s.sim_npv_p50 is not None else "-",
            ]
        )
    return out


def _drivers_table(sim: SimulationResult, limit: int = 10, width: float = CONTENT_W) -> Table | None:
    drivers = sorted(sim.monte_carlo.sensitivity_drivers, key=lambda d: -d.variance_share_pct)[:limit]
    if not drivers:
        return None
    rows = [
        [
            d.driver_label or f"{d.item_label} - {d.parameter_key}",
            d.kind.capitalize(),
            f"{d.spearman_corr:+.2f}",
            f"{d.variance_share_pct:.1f}%",
        ]
        for d in drivers
    ]
    return _data_table(
        ["Driver", "Type", "Rank corr.", "Variance share"],
        rows,
        [width * 0.55, width * 0.15, width * 0.15, width * 0.15],
        align_right_from=2,
    )


def _items_table(bca: BCADetail) -> Table | None:
    if not bca.items:
        return None
    items = sorted(bca.items, key=lambda i: (i.kind != "cost", -abs(i.pv_total)))
    rows = [
        [
            i.label,
            i.kind.capitalize(),
            f"{i.catalog_id}",
            i.value_stream or "-",
            f"Y{i.start_year}-Y{i.end_year}" if i.start_year != i.end_year else f"Y{i.start_year}",
            fmt_money(i.base_annual_value),
            fmt_money(i.pv_total),
        ]
        for i in items
    ]
    w = CONTENT_W
    return _data_table(
        ["Line item", "Type", "Template", "Value stream", "Years", "Annual value", "PV"],
        rows,
        [w * 0.27, w * 0.08, w * 0.12, w * 0.15, w * 0.1, w * 0.14, w * 0.14],
        align_right_from=5,
    )


def _guardrail_flowables(det: DeterministicMetrics) -> list:
    if not det.guardrail_warnings:
        return []
    out = [_p("Double-counting guardrails", "h3")]
    for g in det.guardrail_warnings:
        out.append(_callout(f"<b>{_e(g.tag)}</b>: {_e(g.message)}"))
        out.append(Spacer(1, 4))
    return out


# ---------------------------------------------------------------------------
# Single BCA report
# ---------------------------------------------------------------------------


def _single_summary(bca: BCADetail, sim: SimulationResult | None) -> str:
    det = bca.deterministic
    parts = []
    if det.pv_costs == 0 and det.pv_benefits == 0:
        return "This scenario has no valued line items yet, so there are no financial results to report."
    verdict = "creates" if det.npv >= 0 else "destroys"
    parts.append(
        f"Over a {bca.horizon_years}-year horizon at a {fmt_pct(bca.discount_rate, 1)} discount rate, "
        f"this scenario {verdict} <b>{fmt_compact(abs(det.npv))}</b> of net present value, returning "
        f"{fmt_compact(det.pv_benefits)} in discounted benefits against {fmt_compact(det.pv_costs)} in discounted costs "
        f"(benefit-cost ratio <b>{fmt_ratio(det.bcr)}</b>)."
    )
    if _finite(det.discounted_payback_year):
        parts.append(f"The investment pays back in <b>{fmt_payback(det.discounted_payback_year)}</b> on a discounted basis.")
    else:
        parts.append("Discounted costs are not recovered within the horizon.")
    if sim:
        mc = sim.monte_carlo
        parts.append(
            f"Across {sim.n_simulations:,} Monte Carlo simulations, NPV is positive in <b>{fmt_pct(mc.prob_npv_positive, 0)}</b> "
            f"of outcomes, with a median of {fmt_compact(mc.npv_stats.p50)} and an 80% range from "
            f"{fmt_compact(mc.npv_stats.p10)} (P10) to {fmt_compact(mc.npv_stats.p90)} (P90)."
        )
        top = sorted(mc.sensitivity_drivers, key=lambda d: -d.variance_share_pct)[:1]
        if top:
            parts.append(
                f"The largest source of uncertainty is <i>{_e(top[0].driver_label)}</i> "
                f"({top[0].variance_share_pct:.0f}% of explained variance)."
            )
    else:
        parts.append("No Monte Carlo simulation has been run for this scenario, so risk metrics are not included.")
    return " ".join(parts)


def build_bca_report(
    initiative: InitiativeDetail,
    bca: BCADetail,
    sim: SimulationResult | None,
    *,
    generated_by: str = "",
) -> bytes:
    det = bca.deterministic
    now = datetime.now(timezone.utc)
    story: list = []

    story += _title_block(
        "Business case report",
        bca.name + (" (Baseline)" if bca.is_baseline and "baseline" not in bca.name.lower() else ""),
        initiative.name,
        [
            f"Status: {initiative.status.replace('_', ' ').title()}",
            f"Generated {now.strftime('%b %d, %Y')}",
            f"by {generated_by}" if generated_by else "",
        ],
    )

    if sim and _run_is_stale(sim, bca):
        story += [
            _callout(
                "The scenario's inputs have changed since the Monte Carlo run shown here "
                f"({_fmt_ts(sim.created_at)}). Re-run the simulation for current risk metrics; deterministic figures are current."
            ),
            Spacer(1, 8),
        ]

    tiles = [
        ("Net present value", fmt_compact(det.npv), ""),
        ("Benefit-cost ratio", fmt_ratio(det.bcr), ""),
        ("PV benefits", fmt_compact(det.pv_benefits), ""),
        ("PV costs", fmt_compact(det.pv_costs), ""),
        ("Discounted payback", fmt_payback(det.discounted_payback_year), ""),
    ]
    if sim:
        mc = sim.monte_carlo
        tiles += [
            ("P(NPV > 0)", fmt_pct(mc.prob_npv_positive, 0), f"{sim.n_simulations:,} simulations"),
            ("Median simulated NPV", fmt_compact(mc.npv_stats.p50), f"P10 {fmt_compact(mc.npv_stats.p10)} / P90 {fmt_compact(mc.npv_stats.p90)}"),
            ("P(BCR >= 1)", fmt_pct(mc.prob_bcr_ge_one, 0), ""),
        ]
    else:
        tiles += [("Line items", str(len(bca.items)), ""), ("Value streams", str(len(det.value_streams)), ""), ("Horizon", f"{bca.horizon_years} yrs", "")]

    story += _section("Executive summary", _p(_single_summary(bca, sim)), Spacer(1, 4), _kpi_grid(tiles))

    if bca.description or initiative.description:
        story.append(_p("Scope", "h3"))
        if initiative.description:
            story.append(_p(_e(initiative.description)))
        if bca.description and bca.description.strip() != initiative.description.strip():
            story.append(_p(f"<b>Scenario:</b> {_e(bca.description)}"))

    # Assumptions
    assumption_rows = [
        ["Analysis horizon", f"{bca.horizon_years} years"],
        ["Discount rate", fmt_pct(bca.discount_rate, 2)],
        ["First year", str(bca.cost_start_year) if bca.cost_start_year else "Relative years (Y1 = first year)"],
        ["Line items", f"{sum(1 for i in bca.items if i.kind == 'benefit')} benefits, {sum(1 for i in bca.items if i.kind == 'cost')} costs"],
        ["Domain", initiative.domain or "-"],
    ]
    if sim:
        assumption_rows += [
            ["Monte Carlo run", f"{sim.n_simulations:,} iterations, seed {sim.seed if sim.seed is not None else 'random'}, {_fmt_ts(sim.created_at)}"],
        ]
        notes = _whatif_notes(sim, bca)
        if notes:
            assumption_rows.append(["What-if settings", "; ".join(notes)])
    story += _section(
        "Assumptions",
        _data_table(["Setting", "Value"], assumption_rows, [CONTENT_W * 0.3, CONTENT_W * 0.7], align_right_from=99),
    )

    story += _cash_flow_section(det, bca.cost_start_year)

    if det.value_streams:
        vs_rows = _value_stream_rows(det, sim)
        w = CONTENT_W
        chart = hbar_chart(
            [r[0] for r in vs_rows],
            [
                ("PV benefits", [v.pv_benefits for v in sorted(det.value_streams, key=lambda v: -v.npv)], BENEFIT),
                ("PV costs", [-v.pv_costs for v in sorted(det.value_streams, key=lambda v: -v.npv)], COST),
            ],
        )
        story += _section(
            "Value streams",
            chart,
            Spacer(1, 4),
            _data_table(
                ["Value stream", "Items", "PV benefits", "PV costs", "NPV", "BCR", "Sim. P50 NPV"],
                vs_rows,
                [w * 0.25, w * 0.07, w * 0.15, w * 0.15, w * 0.15, w * 0.09, w * 0.14],
                align_right_from=1,
            ),
        )

    if sim:
        mc = sim.monte_carlo
        hist = mc.npv_histogram
        dist = distribution_chart(
            [("", [b.bin_mid for b in hist], [b.density for b in hist], ACCENT)],
            [
                (mc.npv_stats.p10, "P10", MUTED),
                (mc.npv_stats.p50, "P50", INK),
                (mc.npv_stats.p90, "P90", MUTED),
            ],
            bars=True,
            sign_colors=True,
        )
        pct_rows = [["NPV", *[fmt_compact(getattr(mc.npv_stats, k)) for k in ("p5", "p10", "p25", "p50", "p75", "p90", "p95")], fmt_compact(mc.npv_stats.mean)]]
        if mc.bcr_stats:
            pct_rows.append(["BCR", *[fmt_ratio(getattr(mc.bcr_stats, k)) for k in ("p5", "p10", "p25", "p50", "p75", "p90", "p95")], fmt_ratio(mc.bcr_stats.mean)])
        w = CONTENT_W
        pct_table = _data_table(
            ["Metric", "P5", "P10", "P25", "P50", "P75", "P90", "P95", "Mean"],
            pct_rows,
            [w * 0.12] + [w * 0.11] * 8,
        )
        story += _section(
            "Risk profile (Monte Carlo)",
            _p(
                f"Distribution of simulated NPV across {sim.n_simulations:,} runs. "
                f"Probability NPV is positive: <b>{fmt_pct(mc.prob_npv_positive, 1)}</b>; "
                f"probability BCR is at least 1.0: <b>{fmt_pct(mc.prob_bcr_ge_one, 1)}</b>.",
                "small",
            ),
            dist,
            Spacer(1, 4),
            pct_table,
        )
        bands = mc.yearly_cumulative_npv_bands
        if bands:
            story += _section(
                "Cumulative NPV range over time",
                _p("Simulated cumulative discounted net cash flow by year. The shaded bands show the middle 50% and 80% of outcomes.", "small"),
                fan_chart(
                    [year_short(b.year, bca.cost_start_year) for b in bands],
                    [b.p10 for b in bands],
                    [b.p25 for b in bands],
                    [b.p50 for b in bands],
                    [b.p75 for b in bands],
                    [b.p90 for b in bands],
                ),
            )
        drivers = _drivers_table(sim)
        if drivers:
            story += _section(
                "Key uncertainty drivers",
                _p("Inputs ranked by Spearman rank correlation with simulated NPV. Focus estimation effort on the top rows.", "small"),
                drivers,
            )

    items = _items_table(bca)
    if items:
        story += [CondPageBreak(2 * inch), _p("Line items", "h2"), items]
    story += _guardrail_flowables(det)

    return _build_pdf(
        story,
        title=f"{bca.name} - {initiative.name}",
        footer=f"{initiative.name} - {bca.name} - Business case report - {now.strftime('%Y-%m-%d')}",
        author=generated_by,
    )


# ---------------------------------------------------------------------------
# Comparison report
# ---------------------------------------------------------------------------


def _delta_cell(a: float | None, b: float | None, fmt=fmt_signed_compact, higher_is_better: bool = True) -> Paragraph:
    if not (_finite(a) and _finite(b)):
        return Paragraph("-", STYLES["cell_r"])
    d = b - a
    color = MUTED if abs(d) < 1e-9 else ((BENEFIT if d > 0 else COST) if higher_is_better else (COST if d > 0 else BENEFIT))
    return Paragraph(f'<font color="{color.hexval()}">{_e(fmt(d))}</font>', STYLES["cell_r"])


def _comparison_summary(
    bca_a: BCADetail,
    bca_b: BCADetail,
    sim_a: SimulationResult | None,
    sim_b: SimulationResult | None,
    comparison: BCAComparisonResult | None,
) -> str:
    da, db = bca_a.deterministic, bca_b.deterministic
    a, b = _e(bca_a.name), _e(bca_b.name)
    parts = []
    diff = db.npv - da.npv
    if abs(diff) < 1:
        parts.append(f"<b>{a}</b> and <b>{b}</b> produce the same deterministic NPV ({fmt_compact(da.npv)}).")
    else:
        lead, lag = (b, a) if diff > 0 else (a, b)
        parts.append(
            f"On deterministic NPV, <b>{lead}</b> leads <b>{lag}</b> by <b>{fmt_compact(abs(diff))}</b> "
            f"({fmt_compact(db.npv if diff > 0 else da.npv)} vs {fmt_compact(da.npv if diff > 0 else db.npv)})."
        )
    if _finite(da.bcr) and _finite(db.bcr):
        better = b if db.bcr > da.bcr else a
        parts.append(
            f"{a} returns {fmt_ratio(da.bcr)} per dollar of cost and {b} returns {fmt_ratio(db.bcr)}, "
            f"so {better} is the more capital-efficient option."
            if abs(db.bcr - da.bcr) >= 0.005
            else f"Both return {fmt_ratio(da.bcr)} per dollar of cost."
        )
    cost_diff = db.pv_costs - da.pv_costs
    if abs(cost_diff) >= 1:
        parts.append(
            f"{b} costs {fmt_compact(abs(cost_diff))} {'more' if cost_diff > 0 else 'less'} than {a} in discounted terms."
        )
    if comparison:
        p = comparison.paired
        parts.append(
            f"In a paired simulation of {comparison.n_simulations:,} shared scenarios, {b} beats {a} on NPV in "
            f"<b>{fmt_pct(p.prob_b_beats_a_npv, 0)}</b> of outcomes. The median NPV difference (B - A) is "
            f"{fmt_signed_compact(p.delta_npv_stats.p50)}, with an 80% range of {fmt_signed_compact(p.delta_npv_stats.p10)} "
            f"to {fmt_signed_compact(p.delta_npv_stats.p90)}."
        )
    elif sim_a and sim_b:
        pa, pb = sim_a.monte_carlo.prob_npv_positive, sim_b.monte_carlo.prob_npv_positive
        parts.append(
            f"From their latest individual simulations, NPV is positive in {fmt_pct(pa, 0)} of outcomes for {a} "
            f"and {fmt_pct(pb, 0)} for {b}. Run a paired comparison for a head-to-head win probability."
        )
    else:
        parts.append("Monte Carlo results are not available for both scenarios, so the comparison is deterministic only.")
    if sim_a and sim_b:
        p10a, p10b = sim_a.monte_carlo.npv_stats.p10, sim_b.monte_carlo.npv_stats.p10
        safer = a if p10a > p10b else b
        parts.append(f"{safer} has the stronger downside case (P10 NPV {fmt_compact(max(p10a, p10b))} vs {fmt_compact(min(p10a, p10b))}).")
    return " ".join(parts)


def build_comparison_report(
    initiative: InitiativeDetail,
    bca_a: BCADetail,
    bca_b: BCADetail,
    *,
    comparison: BCAComparisonResult | None,
    sim_a: SimulationResult | None,
    sim_b: SimulationResult | None,
    generated_by: str = "",
) -> bytes:
    """Build the A vs B comparison report. If `comparison` is given, sim_a/sim_b come from it."""
    if comparison:
        sim_a, sim_b = comparison.result_a, comparison.result_b
    da, db = bca_a.deterministic, bca_b.deterministic
    now = datetime.now(timezone.utc)
    name_a, name_b = bca_a.name, bca_b.name
    story: list = []

    story += _title_block(
        "Business case comparison",
        f"{name_a} vs {name_b}",
        initiative.name,
        [
            f"Status: {initiative.status.replace('_', ' ').title()}",
            f"Generated {now.strftime('%b %d, %Y')}",
            f"by {generated_by}" if generated_by else "",
        ],
    )

    stale = [n for n, s, b in ((name_a, sim_a, bca_a), (name_b, sim_b, bca_b)) if s and _run_is_stale(s, b)]
    if stale:
        story += [
            _callout(
                f"Inputs for {', '.join(_e(s) for s in stale)} changed after the simulation used here. "
                "Deterministic figures are current; re-run the comparison for current risk metrics."
            ),
            Spacer(1, 8),
        ]

    # Side-by-side KPI table
    w = CONTENT_W
    head_a = Paragraph(f'<font color="{COLOR_A.hexval()}">A</font> &nbsp;{_e(name_a)}', STYLES["head_r"])
    head_b = Paragraph(f'<font color="{COLOR_B.hexval()}">B</font> &nbsp;{_e(name_b)}', STYLES["head_r"])
    kpi_rows: list[list] = [
        ["Net present value", fmt_compact(da.npv), fmt_compact(db.npv), _delta_cell(da.npv, db.npv)],
        ["Benefit-cost ratio", fmt_ratio(da.bcr), fmt_ratio(db.bcr), _delta_cell(da.bcr, db.bcr, lambda v: f"{v:+.2f}x")],
        ["PV benefits", fmt_compact(da.pv_benefits), fmt_compact(db.pv_benefits), _delta_cell(da.pv_benefits, db.pv_benefits)],
        ["PV costs", fmt_compact(da.pv_costs), fmt_compact(db.pv_costs), _delta_cell(da.pv_costs, db.pv_costs, higher_is_better=False)],
        [
            "Discounted payback",
            fmt_payback(da.discounted_payback_year),
            fmt_payback(db.discounted_payback_year),
            _delta_cell(da.discounted_payback_year, db.discounted_payback_year, lambda v: f"{v:+.1f} yrs", higher_is_better=False),
        ],
    ]
    if sim_a and sim_b:
        ma, mb = sim_a.monte_carlo, sim_b.monte_carlo
        kpi_rows += [
            ["P(NPV > 0)", fmt_pct(ma.prob_npv_positive, 0), fmt_pct(mb.prob_npv_positive, 0), _delta_cell(ma.prob_npv_positive, mb.prob_npv_positive, lambda v: f"{v * 100:+.0f} pts")],
            ["P(BCR >= 1)", fmt_pct(ma.prob_bcr_ge_one, 0), fmt_pct(mb.prob_bcr_ge_one, 0), _delta_cell(ma.prob_bcr_ge_one, mb.prob_bcr_ge_one, lambda v: f"{v * 100:+.0f} pts")],
            ["Simulated NPV P10", fmt_compact(ma.npv_stats.p10), fmt_compact(mb.npv_stats.p10), _delta_cell(ma.npv_stats.p10, mb.npv_stats.p10)],
            ["Simulated NPV P50", fmt_compact(ma.npv_stats.p50), fmt_compact(mb.npv_stats.p50), _delta_cell(ma.npv_stats.p50, mb.npv_stats.p50)],
            ["Simulated NPV P90", fmt_compact(ma.npv_stats.p90), fmt_compact(mb.npv_stats.p90), _delta_cell(ma.npv_stats.p90, mb.npv_stats.p90)],
        ]
    kpi_table = _data_table(["Metric", head_a, head_b, "B vs A"], kpi_rows, [w * 0.31, w * 0.23, w * 0.23, w * 0.23])  # type: ignore[list-item]

    head_to_head: list = []
    if comparison:
        p = comparison.paired
        tiles = [
            ("P(B beats A)", fmt_pct(p.prob_b_beats_a_npv, 0), "on NPV, paired draws"),
            ("Median NPV difference", fmt_signed_compact(p.delta_npv_stats.p50), "B - A"),
            ("NPV difference P10", fmt_signed_compact(p.delta_npv_stats.p10), "downside case, B - A"),
            ("NPV difference P90", fmt_signed_compact(p.delta_npv_stats.p90), "upside case, B - A"),
        ]
        head_to_head = [Spacer(1, 8), _kpi_grid(tiles)]

    story += _section(
        "Executive summary",
        _p(_comparison_summary(bca_a, bca_b, sim_a, sim_b, comparison)),
        *head_to_head,
    )
    story += _section("Key metrics", kpi_table)

    # Assumptions side by side
    def settings(b: BCADetail, s: SimulationResult | None) -> list[str]:
        return [
            f"{b.horizon_years} years",
            fmt_pct(b.discount_rate, 2),
            str(b.cost_start_year) if b.cost_start_year else "Relative (Y1)",
            f"{sum(1 for i in b.items if i.kind == 'benefit')} benefits / {sum(1 for i in b.items if i.kind == 'cost')} costs",
            f"{s.n_simulations:,} @ {_fmt_ts(s.created_at)}" if s else "Not simulated",
            "; ".join(_whatif_notes(s, b)) or "None" if s else "-",
        ]

    sa, sb = settings(bca_a, sim_a), settings(bca_b, sim_b)
    labels = ["Horizon", "Discount rate", "First year", "Line items", "Simulation", "What-if settings"]
    story += _section(
        "Assumptions",
        _data_table(
            ["Setting", head_a, head_b],  # type: ignore[list-item]
            [[lbl, sa[i], sb[i]] for i, lbl in enumerate(labels)],
            [w * 0.24, w * 0.38, w * 0.38],
            align_right_from=99,
        ),
    )
    if bca_a.description or bca_b.description:
        story.append(_p("Scenario descriptions", "h3"))
        for n, b, c in ((name_a, bca_a, COLOR_A), (name_b, bca_b, COLOR_B)):
            if b.description:
                story.append(_p(f'<font color="{c.hexval()}"><b>{_e(n)}</b></font>: {_e(b.description)}'))

    # Cumulative NPV over time
    cost_start = bca_a.cost_start_year or bca_b.cost_start_year
    years_n = max(len(da.yearly_cash_flows), len(db.yearly_cash_flows))
    if years_n:
        def cum(det: DeterministicMetrics) -> list[float]:
            vals = [r.cumulative_net_pv for r in det.yearly_cash_flows]
            return vals + [vals[-1] if vals else 0.0] * (years_n - len(vals))

        def net(det: DeterministicMetrics) -> list[float]:
            vals = [r.net_pv for r in det.yearly_cash_flows]
            return vals + [0.0] * (years_n - len(vals))

        cats = [year_short(y, cost_start) for y in range(1, years_n + 1)]
        chart = bar_line_chart(
            cats,
            [(f"A net PV", net(da), colors.Color(COLOR_A.red, COLOR_A.green, COLOR_A.blue, alpha=0.45)), (f"B net PV", net(db), colors.Color(COLOR_B.red, COLOR_B.green, COLOR_B.blue, alpha=0.45))],
            [("A cumulative", cum(da), COLOR_A, "line"), ("B cumulative", cum(db), COLOR_B, "line")],
        )
        ca, cb, na, nb = cum(da), cum(db), net(da), net(db)
        year_rows = [
            [year_label(y, cost_start), fmt_money(na[y - 1]), fmt_money(nb[y - 1]), fmt_money(ca[y - 1]), fmt_money(cb[y - 1]), _delta_cell(ca[y - 1], cb[y - 1], fmt_signed_compact)]
            for y in range(1, years_n + 1)
        ]
        story += [
            *_section("Net present value over time", _p("Net discounted cash flow per year (bars) and cumulative NPV (lines).", "small"), chart),
            Spacer(1, 6),
            _data_table(["Year", "A net PV", "B net PV", "A cumulative", "B cumulative", "Cumulative B vs A"], year_rows, [w * 0.18] + [w * 0.164] * 5),
        ]

    # Distributions
    if comparison and comparison.paired.aligned_npv_distribution:
        al = comparison.paired.aligned_npv_distribution
        xs = [b.bin_mid for b in al]
        dist = distribution_chart(
            [(f"A {name_a[:30]}", xs, [b.density_a for b in al], COLOR_A), (f"B {name_b[:30]}", xs, [b.density_b for b in al], COLOR_B)],
            [(sim_a.monte_carlo.npv_stats.p50, "A P50", COLOR_A), (sim_b.monte_carlo.npv_stats.p50, "B P50", COLOR_B)] if sim_a and sim_b else [],
        )
        dh = comparison.paired.delta_npv_histogram
        delta = distribution_chart(
            [("", [b.bin_mid for b in dh], [b.density for b in dh], ACCENT)],
            [(comparison.paired.delta_npv_stats.p50, "Median", INK)],
            bars=True,
            sign_colors=True,
            height=1.9 * inch,
        )
        story += _section("Simulated NPV distributions", _p("Both scenarios simulated on the same random draws, so shared uncertainties move together.", "small"), dist)
        story += _section(
            "NPV difference (B - A)",
            _p(f"Bars right of zero are outcomes where {_e(name_b)} beats {_e(name_a)}.", "small"),
            delta,
        )
    elif sim_a and sim_b:
        ha, hb = sim_a.monte_carlo.npv_histogram, sim_b.monte_carlo.npv_histogram
        dist = distribution_chart(
            [
                (f"A {name_a[:30]}", [b.bin_mid for b in ha], [b.density for b in ha], COLOR_A),
                (f"B {name_b[:30]}", [b.bin_mid for b in hb], [b.density for b in hb], COLOR_B),
            ],
            [(sim_a.monte_carlo.npv_stats.p50, "A P50", COLOR_A), (sim_b.monte_carlo.npv_stats.p50, "B P50", COLOR_B)],
        )
        story += _section("Simulated NPV distributions", _p("From each scenario's latest individual simulation run.", "small"), dist)

    # Value streams
    if comparison and comparison.paired.value_stream_comparison:
        vrows = sorted(comparison.paired.value_stream_comparison, key=lambda r: -max(r.a_npv, r.b_npv))
        vs_names = [r.value_stream or "(unassigned)" for r in vrows]
        vs_a = [r.a_npv for r in vrows]
        vs_b = [r.b_npv for r in vrows]
        vs_table_rows = [
            [r.value_stream or "(unassigned)", fmt_compact(r.a_pv_costs), fmt_compact(r.a_npv), fmt_compact(r.b_pv_costs), fmt_compact(r.b_npv), _delta_cell(r.a_npv, r.b_npv)]
            for r in vrows
        ]
    else:
        streams = sorted({v.value_stream for v in da.value_streams} | {v.value_stream for v in db.value_streams})
        by_a = {v.value_stream: v for v in da.value_streams}
        by_b = {v.value_stream: v for v in db.value_streams}

        def g(m, s, attr):
            return getattr(m[s], attr) if s in m else 0.0

        streams.sort(key=lambda s: -max(g(by_a, s, "npv"), g(by_b, s, "npv")))
        vs_names = [s or "(unassigned)" for s in streams]
        vs_a = [g(by_a, s, "npv") for s in streams]
        vs_b = [g(by_b, s, "npv") for s in streams]
        vs_table_rows = [
            [s or "(unassigned)", fmt_compact(g(by_a, s, "pv_costs")), fmt_compact(g(by_a, s, "npv")), fmt_compact(g(by_b, s, "pv_costs")), fmt_compact(g(by_b, s, "npv")), _delta_cell(g(by_a, s, "npv"), g(by_b, s, "npv"))]
            for s in streams
        ]
    if vs_names:
        story += _section(
            "Value streams",
            _p("Deterministic NPV contributed by each value stream.", "small"),
            hbar_chart(vs_names, [(f"A {name_a[:30]}", vs_a, COLOR_A), (f"B {name_b[:30]}", vs_b, COLOR_B)]),
            Spacer(1, 4),
            _data_table(["Value stream", "A PV costs", "A NPV", "B PV costs", "B NPV", "NPV B vs A"], vs_table_rows, [w * 0.25] + [w * 0.15] * 5),
        )

    # Drivers
    driver_blocks = []
    for label, s, c in ((name_a, sim_a, COLOR_A), (name_b, sim_b, COLOR_B)):
        if not s:
            continue
        t = _drivers_table(s, limit=5)
        if t:
            driver_blocks += [Paragraph(f'<font color="{c.hexval()}">{_e(label)}</font>', STYLES["h3"]), t]
    if driver_blocks:
        story += _section(
            "Key uncertainty drivers",
            _p("Top inputs by rank correlation with simulated NPV for each scenario.", "small"),
            *driver_blocks,
            keep=False,
        )

    # Appendix: line items
    story.append(CondPageBreak(3 * inch))
    story.append(_p("Appendix: line items", "h2"))
    for label, b, c in ((name_a, bca_a, COLOR_A), (name_b, bca_b, COLOR_B)):
        story.append(Paragraph(f'<font color="{c.hexval()}">{_e(label)}</font>', STYLES["h3"]))
        t = _items_table(b)
        story.append(t if t else _p("No line items.", "small"))
        story += _guardrail_flowables(b.deterministic)

    return _build_pdf(
        story,
        title=f"{name_a} vs {name_b} - {initiative.name}",
        footer=f"{initiative.name} - {name_a} vs {name_b} - Comparison report - {now.strftime('%Y-%m-%d')}",
        author=generated_by,
    )
