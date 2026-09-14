"""
topology_coords.py
------------------
Parses OpenDSS BusCoords files and scales them to pixel canvas coordinates.
Supports IEEE 13-bus, 34-bus, and 123-bus test feeders.

Expected file layout (relative to backend root):
    examples/ieee13/IEEE13Node_BusXY.csv
    examples/ieee34/ieee34Master.dss          (SetBusXY commands inline)
    examples/ieee123/ieee123Master.dss        (SetBusXY commands inline)
"""

from __future__ import annotations
import re
from pathlib import Path

# Canvas sizes (w x h pixels) tuned per feeder aspect ratio
CANVAS = {
    'ieee13':  (900,  750),
    'ieee34':  (1400, 550),
    'ieee123': (1200, 950),
}
PAD = 80  # px padding so labels never clip

# Internal/phantom buses to exclude from heatmap rendering
INTERNAL_BUSES = {
    "sourcebus",
}
COORD_FILES = {
    'ieee13':  ('ieee13',  'IEEE13Node_BusXY.csv'),
    'ieee34':  ('ieee34',  'ieee34Master.dss'),
    'ieee123': ('ieee123', 'ieee123Master.dss'),
}

# Fallback filenames to try if primary not found
COORD_FILE_FALLBACKS = {
    'ieee34':  ['IEEE34Bus.dss', 'ieee34Mod1.dss', 'ieee34master.dss', 'IEEE34_BusXY.csv'],
    'ieee123': ['IEEE123Bus.dss', 'ieee123master.dss', 'IEEE123_BusXY.csv'],
}


def _parse_csv(path: Path) -> dict[str, tuple[float, float]]:
    coords: dict[str, tuple[float, float]] = {}
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('!') or line.startswith('//'):
                continue
            parts = [p.strip() for p in line.split(',')]
            if len(parts) < 3:
                continue
            try:
                name = parts[0].lower().strip()
                coords[name] = (float(parts[1]), float(parts[2]))
            except ValueError:
                continue
    return coords


def _parse_setbusxy(path: Path) -> dict[str, tuple[float, float]]:
    """
    Parse SetBusXY commands from an OpenDSS .dss file.
    Handles both forms:
      SetBusXY bus=800 X=0 Y=0
      SetBusXY bus=SourceBus X=-300 Y=0
    """
    coords: dict[str, tuple[float, float]] = {}
    # Regex: SetBusXY bus=<name> X=<x> Y=<y>  (any order of X/Y after bus=)
    pattern = re.compile(
        r'SetBusXY\s+bus=(\S+)\s+X=([-\d.]+)\s+Y=([-\d.]+)',
        re.IGNORECASE
    )
    with open(path, encoding='utf-8', errors='replace') as f:
        for raw in f:
            m = pattern.search(raw)
            if m:
                name = m.group(1).lower().strip()
                try:
                    coords[name] = (float(m.group(2)), float(m.group(3)))
                except ValueError:
                    continue
    return coords




def _parse_dss_buscoord(path: Path) -> dict[str, tuple[float, float]]:
    """
    Parse a standalone BusCoord .dss file (3 whitespace-separated columns:
    busname  x  y).
    """
    SKIP = ('new ', 'set ', 'redirect ', 'calcv', 'solve', 'clear', '!',
            '//', 'edit ', 'more ', '~', 'setbusxy')
    coords: dict[str, tuple[float, float]] = {}
    with open(path, encoding='utf-8', errors='replace') as f:
        for raw in f:
            line = raw.strip()
            if not line:
                continue
            if any(line.lower().startswith(p) for p in SKIP):
                continue
            parts = re.split(r'[\s,]+', line)
            if len(parts) >= 3:
                try:
                    name = parts[0].lower().strip()
                    coords[name] = (float(parts[1]), float(parts[2]))
                except ValueError:
                    continue
    return coords


def _parse(path: Path) -> dict[str, tuple[float, float]]:
    """Auto-detect format and parse."""
    suffix = path.suffix.lower()
    if suffix == '.csv':
        return _parse_csv(path)

    # For .dss files: try SetBusXY first (master files with inline coords),
    # then fall back to 3-column buscoord format.
    coords = _parse_setbusxy(path)
    if coords:
        return coords
    return _parse_dss_buscoord(path)


def scale_coords(
    raw: dict[str, tuple[float, float]],
    canvas_w: int,
    canvas_h: int,
    pad: int = PAD,
    exclude: set[str] = INTERNAL_BUSES,
) -> dict[str, tuple[int, int]]:
    """Scale raw feeder coords to pixel coords, flipping Y axis."""
    # Filter out internal buses before scaling
    raw = {k: v for k, v in raw.items() if k.lower() not in exclude}
    if not raw:
        return {}
    xs = [x for x, _ in raw.values()]
    ys = [y for _, y in raw.values()]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    xr = x_max - x_min or 1.0
    yr = y_max - y_min or 1.0
    dw = canvas_w - 2 * pad
    dh = canvas_h - 2 * pad
    return {
        name: (
            int(pad + (x - x_min) / xr * dw),
            int((canvas_h - pad) - (y - y_min) / yr * dh),
        )
        for name, (x, y) in raw.items()
    }


def _find_coord_file(base: Path, topo: str, subdir: str, primary: str) -> Path | None:
    """Try primary filename then fallbacks."""
    candidates = [primary] + COORD_FILE_FALLBACKS.get(topo, [])
    for name in candidates:
        p = base / subdir / name
        if p.exists():
            return p
    # Also try listing the directory for any .dss or .csv
    d = base / subdir
    if d.is_dir():
        for p in sorted(d.iterdir()):
            if p.suffix.lower() in ('.dss', '.csv'):
                return p
    return None


def load_all_coords(examples_dir: str | Path) -> dict[str, dict[str, tuple[int, int]]]:
    """
    Load + scale bus coords for all three IEEE feeders.
    examples_dir should point to the  examples/  folder containing ieee13/, ieee34/, ieee123/.
    """
    base = Path(examples_dir)
    result: dict[str, dict[str, tuple[int, int]]] = {}
    for topo, (subdir, primary) in COORD_FILES.items():
        cw, ch = CANVAS[topo]
        path = _find_coord_file(base, topo, subdir, primary)
        if path and path.exists():
            raw = _parse(path)
            scaled = scale_coords(raw, canvas_w=cw, canvas_h=ch)
            result[topo] = scaled
            print(f"[topology_coords] {topo}: {len(scaled)} buses from {path.name} "
                  f"(raw={len(raw)}, filtered {len(raw)-len(scaled)} internal)")
        else:
            import warnings
            warnings.warn(f"[topology_coords] Not found: {base / subdir / primary}")
            result[topo] = {}
    return result

def get_lines_from_dss(
    coords: dict[str, tuple[int, int]],
    dss_master: Path,
) -> list[tuple[str, str, str]]:
    """
    Extract line AND transformer connections from all OpenDSS files in the case folder.
    Transformers (regulators, substation XFMs) are treated as edges just like lines,
    since they represent physical bus-to-bus connections for topology display.
    """
    if not dss_master.exists():
        return []

    bus1_re = re.compile(r'bus1=([^\s.]+)', re.IGNORECASE)
    bus2_re = re.compile(r'bus2=([^\s.]+)', re.IGNORECASE)
    name_re = re.compile(r'New\s+Line\.(\S+)', re.IGNORECASE)
    seen: set[tuple[str, str]] = set()
    lines: list[tuple[str, str, str]] = []

    coords_lc = {str(k).lower().strip(): v for k, v in coords.items()}
    normalized_coords = {str(k).lower().lstrip('0'): v for k, v in coords_lc.items()}

    dss_dir = dss_master.parent
    dss_files = list(dss_dir.glob("*.dss")) if dss_dir.is_dir() else [dss_master]

    # ── Stitch all files into one flat list of complete statements ────────────
    all_statements: list[str] = []
    for file_path in dss_files:
        with open(file_path, encoding='utf-8', errors='replace') as f:
            current = ""
            for raw in f:
                stripped = raw.strip()
                if not stripped or stripped.startswith('!') or stripped.startswith('//'):
                    if current:
                        all_statements.append(current)
                        current = ""
                    continue
                if stripped.startswith('~'):
                    current += " " + stripped[1:].strip()
                else:
                    if current:
                        all_statements.append(current)
                    current = stripped
            if current:
                all_statements.append(current)

    # ── Pass 1: New Line.* statements ─────────────────────────────────────────
    for stmt in all_statements:
        if 'new line.' not in stmt.lower():
            continue
        _process_normalized_statement(
            stmt, name_re, bus1_re, bus2_re,
            normalized_coords, coords_lc, seen, lines
        )

    # ── Pass 2: New Transformer.* statements (regulators, XFMs) ──────────────
    # These create the regulator bridge connections (650→rg60, 814→814r, etc.)
    for stmt in all_statements:
        if 'new transformer.' not in stmt.lower():
            continue
        _extract_transformer_edge(stmt, coords_lc, seen, lines)

    return lines


def _extract_transformer_edge(
    stmt: str,
    coords_lc: dict,
    seen: set,
    lines: list,
) -> None:
    """
    Extract a bus-pair edge from a (stitched) transformer statement.
    Handles both:
      - buses=[650.1 RG60.1] / buses=(814.1 814r.1)  (inline array)
      - wdg=1 bus=A  wdg=2 bus=B                      (per-winding)
    Skips duplicate phases of the same regulator bank (e.g. Reg1/Reg2/Reg3
    all connect 650→rg60; we only need one edge).
    """
    # Try inline buses=[A B ...] or buses=(A B ...)
    m = re.search(r'buses\s*=\s*[\[\(]([^\]\)]+)[\]\)]', stmt, re.IGNORECASE)
    if m:
        tokens = m.group(1).split()
        cleaned = []
        for t in tokens:
            b = t.split('.')[0].lower().strip()
            if b and b not in cleaned:
                cleaned.append(b)
        if len(cleaned) >= 2:
            _add_edge(cleaned[0], cleaned[1], coords_lc, seen, lines)
        return

    # Fallback: collect all bus=X occurrences in the statement
    bus_matches = re.findall(r'\bbus=(\S+)', stmt, re.IGNORECASE)
    cleaned = []
    for t in bus_matches:
        b = t.split('.')[0].lower().strip()
        if b and b not in cleaned and b not in ('sourcebus',):
            cleaned.append(b)
    if len(cleaned) >= 2:
        _add_edge(cleaned[0], cleaned[1], coords_lc, seen, lines)


def _add_edge(
    b1: str, b2: str,
    coords_lc: dict,
    seen: set,
    lines: list,
) -> None:
    """Add edge if at least one endpoint has coordinates and it's not a duplicate."""
    if b1 not in coords_lc and b2 not in coords_lc:
        return
    key = (min(b1, b2), max(b1, b2))
    if key not in seen:
        seen.add(key)
        lines.append((b1, b2, f"{b1}-{b2}"))
def _process_normalized_statement(statement: str, name_re, bus1_re, bus2_re, normalized_coords, original_coords, seen, lines):
    """Helper to parse and match lines using zero-resilient lookup normalization."""
    mn = name_re.search(statement)
    m1 = bus1_re.search(statement)
    m2 = bus2_re.search(statement)
    
    if mn and m1 and m2:
        # 1. Clean and isolate the base bus names
        b1_raw = m1.group(1).lower().strip()
        b2_raw = m2.group(1).lower().strip()
        
        # 2. Normalize key structure by removing leading zeros
        b1_norm = b1_raw.lstrip('0')
        b2_norm = b2_raw.lstrip('0')
        
        # 3. Check against our flexible coordinate index
        if b1_norm in normalized_coords or b2_norm in normalized_coords:
            # Reconstruct keys using whatever exact casing/format the original coords array expected
            actual_b1 = next((k for k in original_coords if k.lower().lstrip('0') == b1_norm), b1_raw)
            actual_b2 = next((k for k in original_coords if k.lower().lstrip('0') == b2_norm), b2_raw)
            
            key = (min(actual_b1, actual_b2), max(actual_b1, actual_b2))
            if key not in seen:
                seen.add(key)
                lines.append((actual_b1, actual_b2, f"{actual_b1}-{actual_b2}"))
                
                
def _process_statement(statement: str, name_re, bus1_re, bus2_re, coords, seen, lines):
    """Helper to parse a fully stitched multi-line statement."""
    mn = name_re.search(statement)
    m1 = bus1_re.search(statement)
    m2 = bus2_re.search(statement)
    
    if mn and m1 and m2:
        b1 = m1.group(1).lower().strip()
        b2 = m2.group(1).lower().strip()
        
        # Match lines even if they reference a filtered out internal boundary node
        if b1 in coords or b2 in coords:
            key = (min(b1, b2), max(b1, b2))
            if key not in seen:
                seen.add(key)
                lines.append((b1, b2, f"{b1}-{b2}"))