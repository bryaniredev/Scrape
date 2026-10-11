"""Build docs/data/zhvi_pa.json for the GitHub Pages site.

Streams Zillow's ZIP-level home value CSV (~100 MB), keeps Pennsylvania rows and
the last 10 years of monthly values, and writes a compact JSON file:

    {"generated": "...", "zips": {"19010": {"start": "2016-09", "values": [...], "metro": "..."}}}
"""

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pa_home_scout.sources import zillow  # noqa: E402

MONTHS = 121  # 10 years + 1 month so the 5-year change always has a base


def month_index(ym: str) -> int:
    return int(ym[:4]) * 12 + int(ym[5:7]) - 1


def compact(series: list) -> dict | None:
    """[(YYYY-MM-DD, value), ...] -> {"start": "YYYY-MM", "values": [v or None, ...]}"""
    if not series:
        return None
    last = month_index(series[-1][0])
    first = max(month_index(series[0][0]), last - MONTHS + 1)
    values = [None] * (last - first + 1)
    for date, value in series:
        i = month_index(date) - first
        if i >= 0:
            values[i] = value
    return {"start": f"{first // 12:04d}-{first % 12 + 1:02d}", "values": values}


def build(rows: dict) -> dict:
    zips = {}
    for zip_code, entry in rows.items():
        packed = compact(entry["series"])
        if packed:
            packed["metro"] = entry.get("metro", "")
            zips[zip_code] = packed
    return {"generated": dt.date.today().isoformat(), "zips": zips}


def main(out: str = "docs/data/zhvi_pa.json") -> None:
    data = build(zillow._load_pa_rows())
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {len(data['zips'])} PA ZIPs to {path} ({path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main(*sys.argv[1:])
