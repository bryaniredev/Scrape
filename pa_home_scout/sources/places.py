"""Local amenities (OpenStreetMap / Overpass) and top-rated restaurants (Yelp)."""

import re

from .. import config
from ..geo import haversine_miles
from ..http import SourceError, get_json

OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
YELP_URL = "https://api.yelp.com/v3/businesses/search"

# category -> list of (key, regex) OSM tag filters
CATEGORIES = {
    "Grocery stores": [("shop", "^(supermarket|grocery|greengrocer)$")],
    "Pharmacies": [("amenity", "^pharmacy$")],
    "Hospitals & clinics": [("amenity", "^(hospital|clinic)$"), ("healthcare", "^urgent_care$")],
    "Parks & playgrounds": [("leisure", "^(park|playground|nature_reserve)$")],
    "Libraries": [("amenity", "^library$")],
    "Gyms & rec centers": [("leisure", "^(fitness_centre|sports_centre)$")],
    "Coffee shops": [("amenity", "^cafe$")],
    "Restaurants": [("amenity", "^(restaurant|fast_food)$")],
    "Bars & pubs": [("amenity", "^(bar|pub)$")],
    "Childcare & preschools": [("amenity", "^(childcare|kindergarten)$")],
    "Train & subway stations": [("railway", "^(station|halt)$")],
    "Bus stops": [("highway", "^bus_stop$")],
    "Banks": [("amenity", "^bank$")],
    "Gas stations": [("amenity", "^fuel$")],
    "Post offices": [("amenity", "^post_office$")],
    "Places of worship": [("amenity", "^place_of_worship$")],
}
NEAREST_PER_CATEGORY = 5


def _overpass_query(lat: float, lon: float, radius: int) -> str:
    filters = sorted({(k, v) for rules in CATEGORIES.values() for k, v in rules})
    parts = "".join(
        f'nwr(around:{radius},{lat},{lon})["{k}"~"{v}"];' for k, v in filters
    )
    return f"[out:json][timeout:60];({parts});out center tags;"


def _category(tags: dict) -> str | None:
    for name, rules in CATEGORIES.items():
        for key, pattern in rules:
            if key in tags and re.search(pattern, tags[key]):
                return name
    return None


def fetch_amenities(lat: float, lon: float, radius: int = config.AMENITY_RADIUS_METERS) -> dict:
    query = _overpass_query(lat, lon, radius)
    errors = []
    for url in OVERPASS_URLS:
        try:
            data = get_json(url, method="POST", data={"data": query}, ttl=7 * 86400)
            break
        except SourceError as exc:
            errors.append(str(exc))
    else:
        raise SourceError("OpenStreetMap Overpass unavailable: " + "; ".join(errors))

    grouped: dict[str, list[dict]] = {name: [] for name in CATEGORIES}
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        cat = _category(tags)
        e_lat = el.get("lat", el.get("center", {}).get("lat"))
        e_lon = el.get("lon", el.get("center", {}).get("lon"))
        if not cat or e_lat is None:
            continue
        grouped[cat].append({
            "name": tags.get("name") or tags.get("brand") or "",
            "miles": round(haversine_miles(lat, lon, e_lat, e_lon), 2),
            "lat": e_lat,
            "lon": e_lon,
            "cuisine": tags.get("cuisine", "").replace(";", ", ").replace("_", " "),
        })
    summary = {}
    for name, items in grouped.items():
        items.sort(key=lambda i: i["miles"])
        named = [i for i in items if i["name"]]
        summary[name] = {
            "count": len(items),
            "nearest_miles": items[0]["miles"] if items else None,
            "nearest": named[:NEAREST_PER_CATEGORY],
        }
    return {"radius_miles": round(radius / 1609.34, 1), "categories": summary}


def fetch_restaurants(lat: float, lon: float,
                      radius: int = config.RESTAURANT_RADIUS_METERS) -> dict:
    if not config.YELP_API_KEY:
        raise SourceError("Set YELP_API_KEY (free at yelp.com/developers) for rated restaurants.")
    data = get_json(
        YELP_URL,
        params={
            "latitude": lat,
            "longitude": lon,
            "categories": "restaurants",
            "sort_by": "rating",
            "radius": min(radius, 40000),
            "limit": 50,
        },
        headers={"Authorization": f"Bearer {config.YELP_API_KEY}"},
        ttl=7 * 86400,
    )
    out = []
    for b in data.get("businesses", []):
        if (b.get("review_count") or 0) < 25:  # skip 5-stars with a handful of reviews
            continue
        coords = b.get("coordinates") or {}
        out.append({
            "name": b.get("name"),
            "rating": b.get("rating"),
            "reviews": b.get("review_count"),
            "price": b.get("price", ""),
            "categories": ", ".join(c.get("title", "") for c in b.get("categories", [])),
            "address": ", ".join((b.get("location") or {}).get("display_address", [])),
            "miles": round((b.get("distance") or 0) / 1609.34, 1),
            "url": b.get("url"),
            "lat": coords.get("latitude"),
            "lon": coords.get("longitude"),
        })
    out.sort(key=lambda r: (-(r["rating"] or 0), -(r["reviews"] or 0)))
    return {"source": "Yelp", "restaurants": out[:15]}
