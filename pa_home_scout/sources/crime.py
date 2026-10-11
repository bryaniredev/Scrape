"""Crime rates for the nearest police agencies, from the FBI Crime Data Explorer API.

Rates are per 100,000 residents per year and are compared to Pennsylvania and
the US. A free api.data.gov key (DATA_GOV_API_KEY) is recommended; the shared
DEMO_KEY is heavily rate-limited.
"""

import datetime as dt

from .. import config
from ..geo import haversine_miles
from ..http import SourceError, get_json

CDE = "https://api.usa.gov/crime/fbi/cde"
# The summarized endpoint has accepted both short codes and slugs over time.
OFFENSES = {"violent": ("V", "violent-crime"), "property": ("P", "property-crime")}
MAX_AGENCIES = 3
MAX_AGENCY_MILES = 15


def _key() -> dict:
    return {"API_KEY": config.DATA_GOV_API_KEY}


def _agencies(lat: float, lon: float, county_name: str) -> list[dict]:
    data = get_json(f"{CDE}/agency/byStateAbbr/PA", params=_key(), ttl=30 * 86400)
    groups = data.values() if isinstance(data, dict) else [data]
    agencies = []
    for group in groups:
        for a in group if isinstance(group, list) else []:
            a_lat, a_lon = a.get("latitude"), a.get("longitude")
            if a_lat is None or a_lon is None or not a.get("ori"):
                continue
            miles = haversine_miles(lat, lon, float(a_lat), float(a_lon))
            if miles <= MAX_AGENCY_MILES:
                agencies.append({
                    "ori": a["ori"],
                    "name": a.get("agency_name", a["ori"]),
                    "type": a.get("agency_type_name", ""),
                    "miles": round(miles, 1),
                    "same_county": bool(county_name)
                    and county_name.replace(" County", "").upper()
                    in str(a.get("counties", "")).upper(),
                })
    # Local departments first (state police cover large rural areas), then by distance.
    agencies.sort(key=lambda a: ("state police" in a["name"].lower(), a["miles"]))
    return agencies


def _classify(series_name: str, agency_name: str) -> str | None:
    name = series_name.lower()
    if "clearance" in name:
        return None
    if name.startswith("united states"):
        return "us"
    if name.startswith(agency_name.lower()[:20]):
        return "agency"
    if name.startswith("pennsylvania"):
        return "pa"
    return None


def _annual_rate(monthly: dict, year: int) -> tuple[float | None, int]:
    values = [v for k, v in monthly.items() if k.endswith(str(year)) and isinstance(v, (int, float))]
    if not values:
        return None, 0
    return round(sum(values) / len(values) * 12, 1), len(values)


def _offense_rates(ori: str, agency_name: str, codes: tuple, year: int) -> dict | None:
    for code in codes:
        try:
            data = get_json(
                f"{CDE}/summarized/agency/{ori}/{code}",
                params={**_key(), "from": f"01-{year}", "to": f"12-{year}"},
                ttl=30 * 86400,
            )
        except SourceError:
            continue
        rates = (data.get("offenses") or {}).get("rates") or {}
        out = {}
        for series, monthly in rates.items():
            kind = _classify(series, agency_name)
            if kind and isinstance(monthly, dict):
                rate, months = _annual_rate(monthly, year)
                if rate is not None:
                    out[kind] = rate
                    if kind == "agency":
                        out["months_reported"] = months
        if "agency" in out:
            return out
    return None


def fetch_crime(lat: float, lon: float, county_name: str = "") -> dict:
    agencies = _agencies(lat, lon, county_name)
    if not agencies:
        raise SourceError("no reporting police agencies found nearby")
    this_year = dt.date.today().year
    results, comparison, data_year = [], {}, None
    for agency in agencies:
        if len(results) >= MAX_AGENCIES:
            break
        for year in (data_year,) if data_year else range(this_year - 1, this_year - 4, -1):
            entry = {}
            for label, codes in OFFENSES.items():
                rates = _offense_rates(agency["ori"], agency["name"], codes, year)
                if rates:
                    entry[label] = rates["agency"]
                    entry["months_reported"] = rates.get("months_reported")
                    comparison.setdefault(f"{label}_pa", rates.get("pa"))
                    comparison.setdefault(f"{label}_us", rates.get("us"))
            if entry:
                data_year = year
                results.append({**agency, **entry})
                break
    if not results:
        raise SourceError("FBI Crime Data Explorer returned no data for nearby agencies")
    return {
        "year": data_year,
        "agencies": results,
        "pennsylvania": {"violent": comparison.get("violent_pa"),
                         "property": comparison.get("property_pa")},
        "united_states": {"violent": comparison.get("violent_us"),
                          "property": comparison.get("property_us")},
        "links": {
            "FBI Crime Data Explorer": "https://cde.ucr.cjis.gov/",
            "PA Uniform Crime Reporting": "https://www.ucr.pa.gov/",
        },
    }
