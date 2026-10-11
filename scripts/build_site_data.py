"""Build the static data files the GitHub Pages site reads (docs/data/).

Runs in GitHub Actions at deploy time, so the browser never has to call these
sources directly (no CORS problems, no API keys):

* zhvi_pa.json      - Zillow home values by ZIP (see build_zhvi.py)
* acs_pa.json       - Census ACS 5-year neighborhood profile for every PA ZIP
* zcta_pa.json      - ZIP centroids (Census Gazetteer), used for "ZIPs within N minutes"
* emergency_pa.json - hospitals, urgent care, fire and police stations (OpenStreetMap)

Each file is built independently; a failure in one doesn't stop the others.
"""

import csv
import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_zhvi  # noqa: E402
from pa_home_scout import config  # noqa: E402
from pa_home_scout.sources import zillow  # noqa: E402

HEADERS = {"User-Agent": config.USER_AGENT}
ACS_YEARS = (2024, 2023, 2022)

# ACS variable -> key used by docs/app.js
ACS_DETAIL = {
    "B25077_001E": "medianHomeValue", "B25064_001E": "medianRent", "B19013_001E": "medianIncome",
    "B01003_001E": "population", "B01002_001E": "medianAge", "B25003_001E": "occupied",
    "B25003_002E": "ownerOccupied", "B25002_001E": "housingUnits", "B25002_003E": "vacant",
    "B25035_001E": "medianYearBuilt", "B25103_001E": "medianTaxes", "B17001_001E": "povertyUniverse",
    "B17001_002E": "belowPoverty", "B15003_001E": "pop25", "B15003_022E": "bachelors",
    "B15003_023E": "masters", "B15003_024E": "professional", "B15003_025E": "doctorate",
}
ACS_PROFILE = {"DP03_0025E": "commuteMinutes"}

GAZETTEER_URLS = [
    f"https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{y}_Gazetteer/{y}_Gaz_zcta_national.zip"
    for y in (2024, 2023, 2022, 2020)
]
OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
)
OVERPASS_ROUNDS = 2  # public Overpass servers often time out under load; try them all twice
EMERGENCY_QUERY = """[out:json][timeout:300];
area["ISO3166-2"="US-PA"][admin_level=4]->.pa;
(
  nwr["amenity"="hospital"](area.pa);
  nwr["healthcare"="urgent_care"](area.pa);
  nwr["amenity"="clinic"]["urgent_care"="yes"](area.pa);
  nwr["amenity"="fire_station"](area.pa);
  nwr["amenity"="police"](area.pa);
);
out center tags;"""


def is_pa_zip(z: str) -> bool:
    return len(z) == 5 and z.isdigit() and 15000 <= int(z) <= 19699


def _num(v):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n < -1:  # ACS "not available" sentinels
        return None
    return int(n) if n.is_integer() else n


def _census(year: int, dataset: str, variables: dict, geo: str) -> list:
    params = {"get": ",".join(variables), "for": geo}
    if config.CENSUS_API_KEY:
        params["key"] = config.CENSUS_API_KEY
    resp = requests.get(f"https://api.census.gov/data/{year}/{dataset}", params=params,
                        headers=HEADERS, timeout=300)
    resp.raise_for_status()
    try:
        return resp.json()
    except ValueError:
        # Census answers some failures (e.g. key problems) with an HTML page and HTTP 200.
        snippet = " ".join(resp.text.split())[:160]
        raise ValueError(f"HTTP {resp.status_code}, not JSON: {snippet!r}") from None


def parse_acs(rows: list, variables: dict, geo_col: str) -> dict:
    """Census table rows -> {geo id: {key: value}}"""
    header = rows[0]
    gi = header.index(geo_col)
    out = {}
    for row in rows[1:]:
        out[row[gi]] = {variables[h]: _num(v) for h, v in zip(header, row) if h in variables}
    return out


# Census Reporter (censusreporter.org) serves the same ACS tables with no key. Used when the
# Census API itself fails. Table -> {variable column: app key}
REPORTER_URL = "https://api.censusreporter.org/1.0/data/show/latest"
REPORTER_TABLES = {
    "B25077": {"B25077001": "medianHomeValue"},
    "B25064": {"B25064001": "medianRent"},
    "B19013": {"B19013001": "medianIncome"},
    "B01003": {"B01003001": "population"},
    "B01002": {"B01002001": "medianAge"},
    "B25003": {"B25003001": "occupied", "B25003002": "ownerOccupied"},
    "B25002": {"B25002001": "housingUnits", "B25002003": "vacant"},
    "B25035": {"B25035001": "medianYearBuilt"},
    "B25103": {"B25103001": "medianTaxes"},
    "B17001": {"B17001001": "povertyUniverse", "B17001002": "belowPoverty"},
    "B15003": {"B15003001": "pop25", "B15003022": "bachelors", "B15003023": "masters",
               "B15003024": "professional", "B15003025": "doctorate"},
    # mean commute = aggregate travel time / workers who commute
    "B08013": {"B08013001": "_travelTime"},
    "B08303": {"B08303001": "_commuters"},
}


def parse_reporter(payload: dict, columns: dict, out: dict) -> None:
    """Merge one Census Reporter table response into {geoid: {key: value}}."""
    for geoid, tables in (payload.get("data") or {}).items():
        for table in tables.values():
            estimate = table.get("estimate") or {}
            row = out.setdefault(geoid, {})
            for col, key in columns.items():
                row[key] = _num(estimate.get(col))


def finish_reporter_row(row: dict) -> dict:
    travel, commuters = row.pop("_travelTime", None), row.pop("_commuters", None)
    row["commuteMinutes"] = round(travel / commuters, 1) if travel and commuters else None
    return row


def build_acs_reporter() -> dict:
    out, year, skipped = {}, None, []
    for table, columns in REPORTER_TABLES.items():
        # One table at a time so a table Census Reporter can't serve only blanks those fields.
        try:
            resp = requests.get(REPORTER_URL, params={"table_ids": table, "geo_ids": "860|04000US42,04000US42"},
                                headers=HEADERS, timeout=300)
            resp.raise_for_status()
            payload = resp.json()
            if "error" in payload:
                raise ValueError(payload["error"])
        except (requests.RequestException, ValueError) as exc:
            skipped.append(table)
            print(f"Census Reporter {table} skipped: {exc}")
            continue
        parse_reporter(payload, columns, out)
        release = (payload.get("release") or {}).get("id", "")  # e.g. "acs2023_5yr"
        if release[3:7].isdigit():
            year = int(release[3:7])
    zips = {g[-5:]: finish_reporter_row(r) for g, r in out.items() if g.startswith("86000US") and is_pa_zip(g[-5:])}
    if not zips:
        raise ValueError(f"Census Reporter returned no PA ZIP data (failed tables: {', '.join(skipped)})")
    return {"year": year, "zips": zips, "pa": finish_reporter_row(out.get("04000US42", {})),
            "source": "Census Reporter"}


def build_acs() -> dict:
    try:
        return build_acs_census()
    except RuntimeError as exc:
        print(f"Census API failed, falling back to Census Reporter: {exc}")
    return build_acs_reporter()


def build_acs_census() -> dict:
    errors = []
    for year in ACS_YEARS:
        try:
            zcta_col = "zip code tabulation area"
            detail = parse_acs(_census(year, "acs/acs5", ACS_DETAIL, f"{zcta_col}:*"), ACS_DETAIL, zcta_col)
            state = parse_acs(_census(year, "acs/acs5", ACS_DETAIL, "state:42"), ACS_DETAIL, "state")["42"]
        except (requests.RequestException, ValueError, KeyError) as exc:
            errors.append(f"{year}: {exc}")
            continue
        try:
            prof = parse_acs(_census(year, "acs/acs5/profile", ACS_PROFILE, f"{zcta_col}:*"), ACS_PROFILE, zcta_col)
            state.update(parse_acs(_census(year, "acs/acs5/profile", ACS_PROFILE, "state:42"), ACS_PROFILE, "state")["42"])
        except (requests.RequestException, ValueError, KeyError):
            prof = {}
        zips = {}
        for z, values in detail.items():
            if is_pa_zip(z):
                zips[z] = {**values, **prof.get(z, {})}
        return {"year": year, "zips": zips, "pa": state}
    raise RuntimeError("Census ACS unavailable: " + "; ".join(errors))


def parse_gazetteer(text: str) -> dict:
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    header = [h.strip() for h in next(reader)]
    gi, lat, lon = header.index("GEOID"), header.index("INTPTLAT"), header.index("INTPTLONG")
    out = {}
    for row in reader:
        z = row[gi].strip()
        if is_pa_zip(z):
            out[z] = [round(float(row[lat]), 5), round(float(row[lon]), 5)]
    return out


def build_zcta(zhvi_rows: dict | None) -> dict:
    errors = []
    for url in GAZETTEER_URLS:
        try:
            resp = requests.get(url, headers=HEADERS, timeout=300)
            resp.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                text = zf.read(zf.namelist()[0]).decode("utf-8")
            points = parse_gazetteer(text)
            break
        except (requests.RequestException, zipfile.BadZipFile, ValueError, KeyError, IndexError) as exc:
            errors.append(f"{url}: {exc}")
    else:
        raise RuntimeError("Gazetteer unavailable: " + "; ".join(errors))
    # [lat, lon, city] - city names come from Zillow's file when available
    cities = {z: e.get("city", "") for z, e in (zhvi_rows or {}).items()}
    return {z: [lat, lon, cities.get(z, "")] for z, (lat, lon) in points.items()}


def classify_emergency(tags: dict) -> str | None:
    if tags.get("amenity") == "hospital":
        return "hospital"
    if tags.get("healthcare") == "urgent_care" or tags.get("urgent_care") == "yes":
        return "urgent"
    if tags.get("amenity") == "fire_station":
        return "fire"
    if tags.get("amenity") == "police":
        return "police"
    return None


def parse_emergency(data: dict) -> dict:
    out = {"hospital": [], "urgent": [], "fire": [], "police": []}
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        kind = classify_emergency(tags)
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if not kind or lat is None:
            continue
        name = tags.get("name") or tags.get("official_name") or ""
        street = " ".join(filter(None, [tags.get("addr:housenumber"), tags.get("addr:street")]))
        addr = ", ".join(filter(None, [street, tags.get("addr:city")]))
        entry = [round(lat, 5), round(lon, 5), name, addr]
        if kind == "hospital":
            entry.append(1 if tags.get("emergency") == "yes" else 0)
        out[kind].append(entry)
    return out


def build_emergency() -> dict:
    errors = []
    for url in [u for _ in range(OVERPASS_ROUNDS) for u in OVERPASS_URLS]:
        try:
            resp = requests.post(url, data={"data": EMERGENCY_QUERY}, headers=HEADERS, timeout=360)
            resp.raise_for_status()
            result = parse_emergency(resp.json())
            if sum(len(v) for v in result.values()):
                return result
            errors.append(f"{url}: no results")
        except (requests.RequestException, ValueError) as exc:
            errors.append(f"{url}: {exc}")
            time.sleep(10)
    raise RuntimeError("Overpass unavailable: " + "; ".join(errors))


def previous_copy(name: str) -> dict:
    """The copy of ``name`` from the currently deployed site, so a source that's down
    during a deploy doesn't wipe that section off the live site."""
    base = os.environ.get("PREVIOUS_SITE_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("PREVIOUS_SITE_URL not set")
    resp = requests.get(f"{base}/data/{name}", headers=HEADERS, timeout=120)
    resp.raise_for_status()
    return resp.json()


def write(out_dir: Path, name: str, data: dict) -> None:
    path = out_dir / name
    path.write_text(json.dumps(data, separators=(",", ":")))
    print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB)")


def main(out: str = "docs/data") -> int:
    out_dir = Path(out)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = {}

    def zhvi():
        rows["zhvi"] = zillow._load_pa_rows()
        return build_zhvi.build(rows["zhvi"])

    failures = 0
    for name, builder in (
        ("zhvi_pa.json", zhvi),
        ("acs_pa.json", build_acs),
        ("zcta_pa.json", lambda: build_zcta(rows.get("zhvi"))),
        ("emergency_pa.json", build_emergency),
    ):
        try:
            write(out_dir, name, builder())
            continue
        except Exception as exc:  # noqa: BLE001 - keep building the other files
            print(f"{name} failed: {exc}")
        try:
            write(out_dir, name, previous_copy(name))
            print(f"{name}: kept the previously deployed copy")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"{name}: no previous copy either ({exc})")
    print(f"done, {failures} file(s) missing")
    return 0  # partial data is fine; the site shows a notice for anything missing


if __name__ == "__main__":
    raise SystemExit(main(*sys.argv[1:]))
