"""US Census Bureau American Community Survey (5-year) data for a ZIP (ZCTA)."""

from .. import config
from ..http import SourceError, get_json

# Newest first; the first vintage that answers wins.
ACS_YEARS = (2024, 2023, 2022)

DETAIL_VARS = {
    "B25077_001E": "median_home_value",
    "B25064_001E": "median_gross_rent",
    "B19013_001E": "median_household_income",
    "B01003_001E": "population",
    "B01002_001E": "median_age",
    "B25003_001E": "occupied_units",
    "B25003_002E": "owner_occupied_units",
    "B25002_001E": "housing_units",
    "B25002_003E": "vacant_units",
    "B25035_001E": "median_year_built",
    "B25103_001E": "median_real_estate_taxes",
    "B17001_001E": "poverty_universe",
    "B17001_002E": "below_poverty",
    "B15003_001E": "pop_25_plus",
    "B15003_022E": "bachelors",
    "B15003_023E": "masters",
    "B15003_024E": "professional",
    "B15003_025E": "doctorate",
}
PROFILE_VARS = {"DP03_0025E": "mean_commute_minutes"}


def _num(value):
    """ACS uses large negative sentinels (e.g. -666666666) for 'not available'."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return None if n < -1 else n


def _query(year: int, dataset: str, variables: dict, geo: str) -> dict:
    params = {"get": ",".join(variables), "for": geo}
    if config.CENSUS_API_KEY:
        params["key"] = config.CENSUS_API_KEY
    rows = get_json(f"https://api.census.gov/data/{year}/{dataset}", params=params, ttl=30 * 86400)
    if not isinstance(rows, list) or len(rows) < 2:
        raise SourceError(f"no ACS {year} data for {geo}")
    header, values = rows[0], rows[1]
    return {variables[k]: _num(v) for k, v in zip(header, values) if k in variables}


def _derive(raw: dict) -> dict:
    out = dict(raw)

    def pct(num, den):
        if num is None or not den:
            return None
        return round(100 * num / den, 1)

    out["owner_occupied_pct"] = pct(raw.get("owner_occupied_units"), raw.get("occupied_units"))
    out["vacancy_pct"] = pct(raw.get("vacant_units"), raw.get("housing_units"))
    out["poverty_pct"] = pct(raw.get("below_poverty"), raw.get("poverty_universe"))
    degree_parts = [raw.get(k) for k in ("bachelors", "masters", "professional", "doctorate")]
    if all(p is not None for p in degree_parts):
        out["bachelors_or_higher_pct"] = pct(sum(degree_parts), raw.get("pop_25_plus"))
    else:
        out["bachelors_or_higher_pct"] = None
    value, income = raw.get("median_home_value"), raw.get("median_household_income")
    out["price_to_income"] = round(value / income, 1) if value and income else None
    taxes = raw.get("median_real_estate_taxes")
    out["effective_tax_rate_pct"] = round(100 * taxes / value, 2) if taxes and value else None
    for key in ("poverty_universe", "below_poverty", "pop_25_plus", "bachelors", "masters",
                "professional", "doctorate"):
        out.pop(key, None)
    return out


def _fetch(geo: str) -> tuple[int, dict]:
    errors = []
    for year in ACS_YEARS:
        try:
            raw = _query(year, "acs/acs5", DETAIL_VARS, geo)
        except SourceError as exc:
            errors.append(str(exc))
            continue
        try:
            raw.update(_query(year, "acs/acs5/profile", PROFILE_VARS, geo))
        except SourceError:
            raw["mean_commute_minutes"] = None
        return year, _derive(raw)
    raise SourceError("Census ACS unavailable: " + "; ".join(errors))


def fetch_acs(zip_code: str) -> dict:
    """ACS profile for the ZIP plus the Pennsylvania statewide figures for comparison."""
    year, area = _fetch(f"zip code tabulation area:{zip_code}")
    try:
        _, state = _fetch("state:42")
    except SourceError:
        state = {}
    return {"year": year, "zip": area, "pennsylvania": state}
