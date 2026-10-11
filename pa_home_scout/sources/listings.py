"""Homes for sale within an N-minute drive.

Listings come from the RentCast API (free tier available, needs RENTCAST_API_KEY).
Drive times come from the public OSRM routing server; if that's unreachable we
fall back to a straight-line estimate and say so.
"""

import statistics

from .. import config
from ..geo import haversine_miles
from ..http import SourceError, get_json

RENTCAST_URL = "https://api.rentcast.io/v1/listings/sale"
OSRM_TABLE_URL = "https://router.project-osrm.org/table/v1/driving/"
OSRM_CHUNK = 90  # the public server caps table requests at ~100 coordinates

# Fallback when routing is unavailable: road distance ~1.3x straight line, ~35 mph average.
ROAD_FACTOR = 1.3
FALLBACK_MPH = 35


def search_radius_miles(max_minutes: int) -> float:
    """Upper bound on straight-line distance reachable in ``max_minutes`` (~60 mph)."""
    return max(5.0, round(max_minutes * 1.0, 1))


def _osrm_minutes(lat: float, lon: float, points: list[tuple[float, float]]) -> list[float | None]:
    out: list[float | None] = []
    for start in range(0, len(points), OSRM_CHUNK):
        chunk = points[start:start + OSRM_CHUNK]
        coords = ";".join(f"{p_lon:.6f},{p_lat:.6f}" for p_lat, p_lon in [(lat, lon), *chunk])
        data = get_json(
            OSRM_TABLE_URL + coords,
            params={"sources": 0, "annotations": "duration"},
            ttl=7 * 86400,
        )
        if data.get("code") != "Ok":
            raise SourceError(f"OSRM error: {data.get('code')}")
        row = data["durations"][0][1:]
        out.extend(None if d is None else round(d / 60, 1) for d in row)
    return out


def estimate_minutes(lat, lon, p_lat, p_lon) -> float:
    return round(haversine_miles(lat, lon, p_lat, p_lon) * ROAD_FACTOR / FALLBACK_MPH * 60, 1)


def drive_minutes(lat: float, lon: float, points: list[tuple[float, float]]):
    """Return (minutes per point, method) where method is 'osrm' or 'estimate'."""
    if not points:
        return [], "osrm"
    try:
        return _osrm_minutes(lat, lon, points), "osrm"
    except (SourceError, KeyError, IndexError):
        return [estimate_minutes(lat, lon, p_lat, p_lon) for p_lat, p_lon in points], "estimate"


def _normalize(item: dict) -> dict:
    return {
        "address": item.get("formattedAddress") or item.get("addressLine1"),
        "city": item.get("city"),
        "zip": item.get("zipCode"),
        "price": item.get("price"),
        "beds": item.get("bedrooms"),
        "baths": item.get("bathrooms"),
        "sqft": item.get("squareFootage"),
        "year_built": item.get("yearBuilt"),
        "type": item.get("propertyType"),
        "days_on_market": item.get("daysOnMarket"),
        "listed": (item.get("listedDate") or "")[:10],
        "lat": item.get("latitude"),
        "lon": item.get("longitude"),
    }


def _stats(homes: list[dict]) -> dict:
    prices = [h["price"] for h in homes if h.get("price")]
    ppsf = [h["price"] / h["sqft"] for h in homes if h.get("price") and h.get("sqft")]
    dom = [h["days_on_market"] for h in homes if h.get("days_on_market") is not None]
    return {
        "count": len(homes),
        "median_price": round(statistics.median(prices)) if prices else None,
        "min_price": min(prices) if prices else None,
        "max_price": max(prices) if prices else None,
        "median_price_per_sqft": round(statistics.median(ppsf)) if ppsf else None,
        "median_days_on_market": round(statistics.median(dom)) if dom else None,
    }


def search_links(zip_code: str) -> dict:
    return {
        "Zillow": f"https://www.zillow.com/homes/for_sale/{zip_code}_rb/",
        "Redfin": f"https://www.redfin.com/zipcode/{zip_code}",
        "Realtor.com": f"https://www.realtor.com/realestateandhomes-search/{zip_code}",
    }


def fetch_listings(lat: float, lon: float, zip_code: str,
                   max_minutes: int = config.DEFAULT_MAX_DRIVE_MINUTES) -> dict:
    result = {"links": search_links(zip_code), "max_minutes": max_minutes}
    if not config.RENTCAST_API_KEY:
        raise SourceError(
            "Set RENTCAST_API_KEY (free tier at rentcast.io) to list homes for sale here. "
            "Meanwhile use the search links."
        )
    raw = get_json(
        RENTCAST_URL,
        params={
            "latitude": lat,
            "longitude": lon,
            "radius": search_radius_miles(max_minutes),
            "status": "Active",
            "limit": 500,
        },
        headers={"X-Api-Key": config.RENTCAST_API_KEY},
        ttl=6 * 3600,
    )
    if not isinstance(raw, list):
        raise SourceError("unexpected RentCast response")
    homes = [_normalize(i) for i in raw]
    homes = [h for h in homes if h["lat"] is not None and h["lon"] is not None]
    minutes, method = drive_minutes(lat, lon, [(h["lat"], h["lon"]) for h in homes])
    for home, m in zip(homes, minutes):
        home["drive_minutes"] = m
        home["miles"] = round(haversine_miles(lat, lon, home["lat"], home["lon"]), 1)
    within = [h for h in homes if h["drive_minutes"] is not None and h["drive_minutes"] <= max_minutes]
    within.sort(key=lambda h: (h["drive_minutes"], h["price"] or 0))
    in_zip = [h for h in within if h["zip"] == zip_code]
    result.update(
        {
            "drive_time_method": method,
            "homes": within,
            "stats": _stats(within),
            "in_zip_stats": _stats(in_zip),
        }
    )
    return result
