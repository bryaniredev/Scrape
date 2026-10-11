"""Nearby public & charter schools with ratings.

* School directory: NCES Common Core of Data via the Urban Institute Education
  Data API (free, no key).
* Ratings: GreatSchools 1-10 ratings when GREATSCHOOLS_API_KEY is set; otherwise
  a proficiency score derived from Pennsylvania state test results (EDFacts),
  clearly labelled as such.
"""

from concurrent.futures import ThreadPoolExecutor

from .. import config
from ..geo import haversine_miles
from ..http import SourceError, get_json

URBAN = "https://educationdata.urban.org/api/v1/schools"
DIRECTORY_YEARS = (2023, 2022, 2021)
# EDFacts assessment years (2019-20 had no testing; newest first).
ASSESSMENT_YEARS = (2022, 2021, 2018)
GREATSCHOOLS_URL = "https://gs-api.greatschools.org/nearby-schools"

LEVELS = {0: "Pre-K", 1: "Elementary", 2: "Middle", 3: "High", 4: "Other"}
GRADE_NAMES = {-1: "PK", 0: "K"}
CLOSED_STATUSES = {2, 6, 7}  # closed, inactive, future
PER_LEVEL = 6  # nearest N schools per level


def _urban_pages(url: str, params: dict) -> list[dict]:
    results, next_url, next_params = [], url, params
    for _ in range(20):  # page cap
        data = get_json(next_url, params=next_params, ttl=30 * 86400)
        results.extend(data.get("results", []))
        next_url, next_params = data.get("next"), None
        if not next_url:
            break
    return results


def _directory(county_fips: str) -> tuple[int, list[dict]]:
    errors = []
    for year in DIRECTORY_YEARS:
        try:
            rows = _urban_pages(
                f"{URBAN}/ccd/directory/{year}/",
                {"fips": 42, "county_code": county_fips},
            )
        except SourceError as exc:
            errors.append(str(exc))
            continue
        if rows:
            return year, rows
    raise SourceError("school directory unavailable: " + "; ".join(errors or ["no rows"]))


def _is_total_row(row: dict) -> bool:
    """EDFacts rows are disaggregated by subgroup; 99 means 'all students'."""
    for key in ("race", "sex", "lep", "homeless", "migrant", "disability", "econ_disadvantaged",
                "foster_care", "military_connected"):
        if key in row and row[key] not in (99, None):
            return False
    return True


def _proficiency(ncessch: str) -> dict | None:
    for year in ASSESSMENT_YEARS:
        try:
            rows = get_json(
                f"{URBAN}/edfacts/assessments/{year}/grade-99/",
                params={"ncessch": ncessch},
                ttl=30 * 86400,
            ).get("results", [])
        except SourceError:
            continue
        for row in rows:
            if not _is_total_row(row):
                continue
            read, math = row.get("read_test_pct_prof_midpt"), row.get("math_test_pct_prof_midpt")
            vals = [v for v in (read, math) if isinstance(v, (int, float)) and v >= 0]
            if vals:
                avg = sum(vals) / len(vals)
                return {
                    "year": year,
                    "reading_pct_proficient": read if read is not None and read >= 0 else None,
                    "math_pct_proficient": math if math is not None and math >= 0 else None,
                    "score": max(1, min(10, round(avg / 10))),
                }
    return None


def _grades(low, high) -> str:
    if low is None or high is None or low < -1 or high < -1:
        return ""
    return f"{GRADE_NAMES.get(low, low)}-{GRADE_NAMES.get(high, high)}"


def _normalize_ccd(row: dict, lat: float, lon: float) -> dict | None:
    s_lat, s_lon = row.get("latitude"), row.get("longitude")
    if s_lat is None or s_lon is None or row.get("school_status") in CLOSED_STATUSES:
        return None
    enrollment, teachers = row.get("enrollment"), row.get("teachers_fte")
    return {
        "ncessch": str(row.get("ncessch", "")),
        "name": row.get("school_name"),
        "district": row.get("lea_name"),
        "level": LEVELS.get(row.get("school_level"), "Other"),
        "grades": _grades(row.get("lowest_grade_offered"), row.get("highest_grade_offered")),
        "charter": row.get("charter") == 1,
        "virtual": row.get("virtual") not in (None, 0, -1, -2),
        "enrollment": enrollment if enrollment and enrollment > 0 else None,
        "student_teacher_ratio": round(enrollment / teachers, 1)
        if enrollment and teachers and enrollment > 0 and teachers > 0 else None,
        "address": ", ".join(filter(None, [row.get("street_location"), row.get("city_location")])),
        "lat": s_lat,
        "lon": s_lon,
        "miles": round(haversine_miles(lat, lon, s_lat, s_lon), 1),
    }


def _greatschools(lat: float, lon: float) -> list[dict]:
    data = get_json(
        GREATSCHOOLS_URL,
        params={"lat": lat, "lon": lon, "limit": 40, "distance": config.SCHOOL_RADIUS_MILES},
        headers={"x-api-key": config.GREATSCHOOLS_API_KEY},
        ttl=7 * 86400,
    )
    schools = []
    for s in data.get("schools", []):
        if s.get("lat") is None or s.get("lon") is None:
            continue
        schools.append({
            "name": s.get("name"),
            "district": s.get("district-name"),
            "level": s.get("level") or s.get("level-codes"),
            "type": s.get("type"),
            "rating": s.get("rating"),
            "address": ", ".join(filter(None, [s.get("street"), s.get("city")])),
            "url": s.get("overview-url") or s.get("web-site"),
            "lat": float(s["lat"]),
            "lon": float(s["lon"]),
            "miles": round(haversine_miles(lat, lon, float(s["lat"]), float(s["lon"])), 1),
        })
    schools.sort(key=lambda s: s["miles"])
    return schools


def fetch_schools(lat: float, lon: float, county_fips: str) -> dict:
    links = {
        "GreatSchools": f"https://www.greatschools.org/search/search.page?lat={lat}&lon={lon}&distance=5",
        "PA Future Ready Index": "https://futurereadypa.org/",
    }
    if config.GREATSCHOOLS_API_KEY:
        try:
            schools = _greatschools(lat, lon)
            if schools:
                return {"source": "GreatSchools", "rating_label": "GreatSchools rating (1-10)",
                        "schools": schools, "links": links}
        except SourceError:
            pass  # fall through to the free sources

    if not county_fips:
        raise SourceError("county unknown, cannot look up schools")
    year, rows = _directory(county_fips)
    schools = [s for s in (_normalize_ccd(r, lat, lon) for r in rows) if s]
    schools = [s for s in schools if s["miles"] <= config.SCHOOL_RADIUS_MILES and not s["virtual"]]
    schools.sort(key=lambda s: s["miles"])
    picked, per_level = [], {}
    for s in schools:
        if per_level.get(s["level"], 0) < PER_LEVEL:
            per_level[s["level"]] = per_level.get(s["level"], 0) + 1
            picked.append(s)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for school, prof in zip(picked, pool.map(lambda s: _proficiency(s["ncessch"]), picked)):
            school["proficiency"] = prof
            school["rating"] = prof["score"] if prof else None
    return {
        "source": f"NCES Common Core of Data {year} + PA state test results (EDFacts)",
        "rating_label": "Proficiency score (1-10, avg % proficient in reading & math / 10)",
        "schools": picked,
        "links": links,
    }
