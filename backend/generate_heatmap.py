"""
generate_heatmap.py  v2
-----------------------
Pure-SVG topology heatmap. No matplotlib.
Coords arrive already scaled to pixel space from topology_coords.py.
"""

from __future__ import annotations
import xml.etree.ElementTree as ET
import math


def _voltage_color(v: float) -> str:
    if v >= 1.05:   return "#22c55e"
    elif v >= 1.00: return "#4ade80"
    elif v >= 0.97: return "#facc15"
    elif v >= 0.95: return "#fb923c"
    else:           return "#ef4444"


def _sizes(num_buses: int) -> dict:
    if num_buses > 100:
        return dict(r=5,  lw=1.2, fs=8,  fs_edge=6,  label_offset=14)
    elif num_buses > 34:
        return dict(r=7,  lw=1.8, fs=10, fs_edge=8,  label_offset=18)
    else:
        return dict(r=9,  lw=2.2, fs=11, fs_edge=9,  label_offset=20)


def generate_heatmap(
    voltages:       list[float],
    bus_names:      list[str],
    coords:         dict,
    lines:          list,
    output_path:    str,
    canvas_w:       int  = 900,
    canvas_h:       int  = 750,
    dc_bus:         str | None = None,
    substation_bus: str        = "650",
    topology:       str        = "ieee13",
):
    # ── 1. Build lookups ──────────────────────────────────────────────────────
    coords_lc = {str(k).lower().strip(): v for k, v in coords.items()}

    name_to_v:   dict[str, float]          = {}
    name_to_pos: dict[str, tuple[int,int]] = {}
    for i, name in enumerate(bus_names):
        key = str(name).lower().strip()
        name_to_v[key]   = voltages[i] if i < len(voltages) else 1.0
        if key in coords_lc:
            name_to_pos[key] = coords_lc[key]

    # ── 2. Virtual regulator coord patch (IEEE-13: rg60 between 650 and 632) ─
    if "650" in coords_lc and "rg60" not in coords_lc and "632" in coords_lc:
        x0, y0 = coords_lc["650"]
        x1, y1 = coords_lc["632"]
        coords_lc["rg60"] = (int(x0 + 0.3*(x1-x0)), int(y0 + 0.3*(y1-y0)))

    sz  = _sizes(len(bus_names))
    r   = sz["r"]
    lw  = sz["lw"]
    fs  = sz["fs"]
    fse = sz["fs_edge"]
    loff = sz["label_offset"]

    # Skip edge labels for dense topologies
    skip_edge_labels = len(bus_names) > 50

    # ── 3. SVG root ───────────────────────────────────────────────────────────
    svg = ET.Element("svg", {
        "xmlns":   "http://www.w3.org/2000/svg",
        "width":   str(canvas_w),
        "height":  str(canvas_h),
        "viewBox": f"0 0 {canvas_w} {canvas_h}",
    })
    ET.SubElement(svg, "rect", {
        "width": str(canvas_w), "height": str(canvas_h), "fill": "#f8fafc",
    })

    # ── 4. Lines ──────────────────────────────────────────────────────────────
    for entry in lines:
        b1 = str(entry[0]).split(".")[0].lower().strip()
        b2 = str(entry[1]).split(".")[0].lower().strip()
        label = str(entry[2]) if len(entry) > 2 else ""

        # Skip open-point switches (bus names ending in _open or _open.N)
        if "_open" in b1 or "_open" in b2:
            continue

        p1 = coords_lc.get(b1)
        p2 = coords_lc.get(b2)
        if p1 is None and p2 is None:
            continue
        if p1 is None: p1 = p2
        if p2 is None: p2 = p1
        x1c, y1c = p1
        x2c, y2c = p2
        if x1c == x2c and y1c == y2c:
            continue

        # Halo + core line
        ET.SubElement(svg, "line", {
            "x1": str(x1c), "y1": str(y1c), "x2": str(x2c), "y2": str(y2c),
            "stroke": "white", "stroke-width": str(lw * 2.8),
            "stroke-linecap": "round",
        })
        ET.SubElement(svg, "line", {
            "x1": str(x1c), "y1": str(y1c), "x2": str(x2c), "y2": str(y2c),
            "stroke": "#1e293b", "stroke-width": str(lw),
            "stroke-linecap": "round",
        })

        # Edge label — only for sparse topologies, placed along line
        if not skip_edge_labels and label:
            mx, my = (x1c + x2c) // 2, (y1c + y2c) // 2
            tw = len(label) * fse * 0.58
            th = fse + 2
            ET.SubElement(svg, "rect", {
                "x": str(mx - tw/2 - 2), "y": str(my - th/2 - 1),
                "width": str(tw + 4), "height": str(th + 2),
                "rx": "2", "fill": "white", "opacity": "0.9",
                "stroke": "#cbd5e1", "stroke-width": "0.6",
            })
            t = ET.SubElement(svg, "text", {
                "x": str(mx), "y": str(my + fse*0.35),
                "text-anchor": "middle", "font-size": str(fse),
                "font-family": "monospace", "fill": "#64748b",
            })
            t.text = label

    # ── 5. Nodes ──────────────────────────────────────────────────────────────
    # Collect all positions to detect overlapping labels
    placed_labels: list[tuple[float,float,float,float]] = []  # (x,y,w,h) bboxes

    def _overlaps(x: float, y: float, w: float, h: float) -> bool:
        for bx, by, bw, bh in placed_labels:
            if abs(x - bx) < (w + bw)/2 + 2 and abs(y - by) < (h + bh)/2 + 2:
                return True
        return False

    for i, name in enumerate(bus_names):
        key = str(name).lower().strip()
        if key not in name_to_pos:
            continue

        px, py   = name_to_pos[key]
        v        = name_to_v.get(key, 1.0)
        color    = _voltage_color(v)
        is_sub   = key == str(substation_bus).lower().strip()
        is_dc    = dc_bus is not None and key == str(dc_bus).lower().strip()

        # DC bus highlight ring
        if is_dc:
            ET.SubElement(svg, "circle", {
                "cx": str(px), "cy": str(py), "r": str(r + 5),
                "fill": "none", "stroke": "#7c3aed", "stroke-width": "2",
                "stroke-dasharray": "4 2",
            })

        # Node shape
        if is_sub:
            ET.SubElement(svg, "rect", {
                "x": str(px - r), "y": str(py - r),
                "width": str(r*2), "height": str(r*2),
                "fill": color, "stroke": "#0f172a", "stroke-width": "1.8",
            })
        else:
            ET.SubElement(svg, "circle", {
                "cx": str(px), "cy": str(py), "r": str(r),
                "fill": color, "stroke": "#0f172a", "stroke-width": "1.4",
            })

        # Label — try above first, fall back to below if overlapping
        label_text = f"{name}  {v:.3f} p.u."
        tw = len(label_text) * fs * 0.60
        th = fs + 2

        # Candidate positions: above, below, right, left
        candidates = [
            (px,          py - r - loff),      # above (preferred)
            (px,          py + r + loff + 2),  # below
            (px + r + tw/2 + 4, py),           # right
            (px - r - tw/2 - 4, py),           # left
        ]
        tx, ty = candidates[0]   # default: above
        for cx, cy in candidates:
            if not _overlaps(cx, cy, tw, th):
                tx, ty = cx, cy
                break

        placed_labels.append((tx, ty, tw, th))

        # White backing rect
        ET.SubElement(svg, "rect", {
            "x": str(tx - tw/2 - 2), "y": str(ty - th/2 - 1),
            "width": str(tw + 4), "height": str(th + 2),
            "rx": "2", "fill": "white", "opacity": "0.88",
        })
        ET.SubElement(svg, "text", {
            "x": str(tx), "y": str(ty + fs*0.35),
            "text-anchor": "middle",
            "font-size": str(fs),
            "font-family": "Arial, sans-serif",
            "font-weight": "bold" if is_sub else "normal",
            "fill": "#0f172a",
        }).text = label_text

    # ── 6. Write ──────────────────────────────────────────────────────────────
    tree = ET.ElementTree(svg)
    ET.indent(tree, space="  ")
    tree.write(output_path, encoding="unicode", xml_declaration=False)
    print(f"[{topology}] SVG written → {output_path}  ({len(bus_names)} buses)")