"""Zillow Home Value Index (ZHVI) by ZIP: typical home value and its trend.

Zillow publishes this as a free CSV covering every US ZIP (~100 MB). We stream
it once, keep only Pennsylvania rows, and cache that subset for a week.
"""

import csv
import json
import time

from .. import config
from ..http import SourceError, stream_lines

ZHVI_URL = (
    "https://files.zillowstatic.com/research/public_csvs/zhvi/"
    "Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv"
)
CACHE_TTL = 7 * 86400


def _cache_file():
    return config.CACHE_DIR / "zhvi_pa.json"


def _load_pa_rows() -> dict:
    path = _cache_file()
    try:
        if time.time() - path.stat().st_mtime < CACHE_TTL:
            return json.loads(path.read_text())
    except (OSError, ValueError):
        pass

    reader = csv.reader(stream_lines(ZHVI_URL))
    header = next(reader)
    idx = {name: i for i, name in enumerate(header)}
    date_cols = [(i, name) for i, name in enumerate(header) if name[:2] in ("19", "20")]
    rows = {}
    for row in reader:
        if len(row) != len(header) or row[idx["State"]] != "PA":
            continue
        series = [(d, round(float(row[i]))) for i, d in date_cols if row[i]]
        rows[row[idx["RegionName"]].zfill(5)] = {
            "city": row[idx["City"]],
            "metro": row[idx["Metro"]],
            "county": row[idx["CountyName"]],
            "series": series,
        }
    if not rows:
        raise SourceError("Zillow CSV contained no Pennsylvania rows")
    try:
        config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rows))
    except OSError:
        pass
    return rows


def _value_months_ago(series, months):
    """Value for the same month ``months`` earlier (series dates are YYYY-MM-DD)."""
    year, month = int(series[-1][0][:4]), int(series[-1][0][5:7])
    total = year * 12 + month - 1 - months
    target = f"{total // 12:04d}-{total % 12 + 1:02d}"
    for date, value in series:
        if date.startswith(target):
            return value
    return None


def _change(now, then):
    return round(100 * (now - then) / then, 1) if now and then else None


def summarize(entry: dict) -> dict:
    series = entry["series"]
    if not series:
        raise SourceError("no ZHVI values for this ZIP")
    latest_date, latest = series[-1]
    one_year = _value_months_ago(series, 12)
    five_year = _value_months_ago(series, 60)
    return {
        "as_of": latest_date,
        "typical_home_value": latest,
        "change_1y_pct": _change(latest, one_year),
        "change_5y_pct": _change(latest, five_year),
        "history": series[-120:],  # last 10 years, monthly
        "metro": entry.get("metro"),
    }


def fetch_zhvi(zip_code: str) -> dict:
    rows = _load_pa_rows()
    entry = rows.get(zip_code)
    if not entry:
        raise SourceError(f"Zillow does not publish a home value index for {zip_code}")
    return summarize(entry)
