"""Zip-code geocoding and distance helpers."""

import math
import re
from dataclasses import asdict, dataclass

from .http import SourceError, get_json

EARTH_RADIUS_MILES = 3958.8


@dataclass
class Location:
    zip: str
    lat: float
    lon: float
    place: str
    state: str = "PA"
    county: str = ""
    county_fips: str = ""  # 5-digit, e.g. "42101"

    def to_dict(self) -> dict:
        return asdict(self)


def is_pa_zip(zip_code: str) -> bool:
    """Pennsylvania zip codes are 150xx-196xx."""
    return bool(re.fullmatch(r"\d{5}", zip_code or "")) and 15000 <= int(zip_code) <= 19699


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MILES * math.asin(math.sqrt(a))


def _geocode_zippopotam(zip_code: str) -> tuple[float, float, str, str]:
    data = get_json(f"https://api.zippopotam.us/us/{zip_code}", ttl=30 * 86400)
    place = data["places"][0]
    return (
        float(place["latitude"]),
        float(place["longitude"]),
        place["place name"],
        place["state abbreviation"],
    )


def _geocode_nominatim(zip_code: str) -> tuple[float, float, str, str]:
    data = get_json(
        "https://nominatim.openstreetmap.org/search",
        params={"postalcode": zip_code, "country": "us", "format": "json", "addressdetails": 1},
        ttl=30 * 86400,
    )
    if not data:
        raise SourceError(f"no geocoding result for {zip_code}")
    hit = data[0]
    addr = hit.get("address", {})
    place = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("county", "")
    state = "PA" if addr.get("state") == "Pennsylvania" else addr.get("state", "")
    return float(hit["lat"]), float(hit["lon"]), place, state


def _county_for_point(lat: float, lon: float) -> tuple[str, str]:
    """Return (county name, 5-digit county FIPS)."""
    try:
        data = get_json(
            "https://geo.fcc.gov/api/census/area",
            params={"lat": lat, "lon": lon, "censusYear": 2020, "format": "json"},
            ttl=30 * 86400,
        )
        hit = data["results"][0]
        return hit["county_name"], hit["county_fips"]
    except (SourceError, KeyError, IndexError):
        pass
    data = get_json(
        "https://geocoding.geo.census.gov/geocoder/geographies/coordinates",
        params={
            "x": lon,
            "y": lat,
            "benchmark": "Public_AR_Current",
            "vintage": "Current_Current",
            "layers": "Counties",
            "format": "json",
        },
        ttl=30 * 86400,
    )
    county = data["result"]["geographies"]["Counties"][0]
    return county["NAME"], county["GEOID"]


def geocode_zip(zip_code: str) -> Location:
    zip_code = (zip_code or "").strip()
    if not is_pa_zip(zip_code):
        raise ValueError(f"{zip_code!r} is not a Pennsylvania zip code (PA zips run 15001-19640)")
    errors = []
    for geocoder in (_geocode_zippopotam, _geocode_nominatim):
        try:
            lat, lon, place, state = geocoder(zip_code)
            break
        except (SourceError, KeyError, IndexError, ValueError) as exc:
            errors.append(str(exc))
    else:
        raise SourceError("could not geocode zip: " + "; ".join(errors))
    if state and state != "PA":
        raise ValueError(f"{zip_code} is in {state}, not Pennsylvania")
    loc = Location(zip=zip_code, lat=lat, lon=lon, place=place)
    try:
        loc.county, loc.county_fips = _county_for_point(lat, lon)
    except (SourceError, KeyError, IndexError):
        pass  # county is only needed for schools/crime; those sections will report it
    return loc
