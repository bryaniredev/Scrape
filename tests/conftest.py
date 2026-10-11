"""Offline fixtures: every network call is answered from canned API-shaped responses."""

import pytest

from pa_home_scout import config, http
from pa_home_scout.sources import zillow

LAT, LON = 40.0379, -75.3460  # Bryn Mawr / Haverford area

ZILLOW_CSV = [
    'RegionID,SizeRank,RegionName,RegionType,StateName,State,City,Metro,CountyName,2015-01-31,2020-01-31,2021-01-31,2025-08-31,2026-08-31',
    '1,100,19010,zip,PA,PA,Bryn Mawr,"Philadelphia-Camden-Wilmington, PA-NJ-DE-MD",Montgomery County,500000,600000,620000,780000,819000',
    '2,200,07030,zip,NJ,NJ,Hoboken,New York,Hudson County,1,2,3,4,5',
]


def _acs(url, params):
    is_state = params["for"].startswith("state")
    if "profile" in url:
        return [["DP03_0025E", "state"], ["27.5" if is_state else "29.1", "42"]]
    values = {
        "B25077_001E": "250000" if is_state else "760000",
        "B25064_001E": "1100" if is_state else "1650",
        "B19013_001E": "73000" if is_state else "145000",
        "B01003_001E": "13000000" if is_state else "21000",
        "B01002_001E": "40.9" if is_state else "-666666666",
        "B25003_001E": "100", "B25003_002E": "69" if is_state else "72",
        "B25002_001E": "110", "B25002_003E": "10",
        "B25035_001E": "1965" if is_state else "1952",
        "B25103_001E": "3600" if is_state else "11400",
        "B17001_001E": "1000", "B17001_002E": "120" if is_state else "50",
        "B15003_001E": "1000", "B15003_022E": "200", "B15003_023E": "100",
        "B15003_024E": "30", "B15003_025E": "20",
    }
    names = params["get"].split(",")
    return [names + ["geo"], [values[n] for n in names] + ["x"]]


def _osrm(url, params):
    n = url.rsplit("/", 1)[1].count(";")
    # listing i is 5 + 10*i minutes away -> 0 and 1 are within 20 min, 2 is not
    return {"code": "Ok", "durations": [[0] + [(5 + 10 * i) * 60 for i in range(n)]]}


LISTINGS = [
    {"formattedAddress": "1 Elm St, Bryn Mawr, PA 19010", "zipCode": "19010", "price": 650000,
     "bedrooms": 3, "bathrooms": 2, "squareFootage": 1800, "yearBuilt": 1930,
     "propertyType": "Single Family", "daysOnMarket": 12, "listedDate": "2026-09-29T00:00:00.000Z",
     "latitude": LAT + 0.01, "longitude": LON},
    {"formattedAddress": "9 Oak Ave, Ardmore, PA 19003", "zipCode": "19003", "price": 450000,
     "bedrooms": 2, "bathrooms": 1.5, "squareFootage": 1200, "propertyType": "Townhouse",
     "daysOnMarket": 30, "latitude": LAT, "longitude": LON + 0.03},
    {"formattedAddress": "Far Away Rd, Malvern, PA 19355", "zipCode": "19355", "price": 900000,
     "latitude": LAT + 0.1, "longitude": LON - 0.2},
]

SCHOOLS = {"count": 3, "next": None, "results": [
    {"ncessch": "421", "school_name": "Bryn Mawr Elementary", "lea_name": "Lower Merion SD",
     "school_level": 1, "lowest_grade_offered": 0, "highest_grade_offered": 5, "charter": 0,
     "virtual": 0, "enrollment": 450, "teachers_fte": 30.0, "school_status": 1,
     "latitude": LAT + 0.005, "longitude": LON, "street_location": "1 School Ln", "city_location": "Bryn Mawr"},
    {"ncessch": "422", "school_name": "Harriton High", "lea_name": "Lower Merion SD",
     "school_level": 3, "lowest_grade_offered": 9, "highest_grade_offered": 12, "charter": 0,
     "virtual": 0, "enrollment": 1200, "teachers_fte": 90, "school_status": 1,
     "latitude": LAT + 0.02, "longitude": LON + 0.01},
    {"ncessch": "423", "school_name": "Closed School", "school_level": 1, "school_status": 2,
     "latitude": LAT, "longitude": LON},
]}

ASSESSMENTS = {"results": [
    {"ncessch": "421", "race": 1, "sex": 99, "read_test_pct_prof_midpt": 10, "math_test_pct_prof_midpt": 10},
    {"ncessch": "421", "race": 99, "sex": 99, "read_test_pct_prof_midpt": 82.5, "math_test_pct_prof_midpt": 74.5},
]}

OVERPASS = {"elements": [
    {"type": "node", "lat": LAT + 0.004, "lon": LON, "tags": {"shop": "supermarket", "name": "Acme"}},
    {"type": "way", "center": {"lat": LAT + 0.01, "lon": LON}, "tags": {"leisure": "park", "name": "Ashbridge Park"}},
    {"type": "node", "lat": LAT, "lon": LON + 0.002, "tags": {"amenity": "restaurant", "name": "Tavola", "cuisine": "italian;pizza"}},
    {"type": "node", "lat": LAT, "lon": LON + 0.001, "tags": {"railway": "station", "name": "Bryn Mawr"}},
    {"type": "node", "lat": LAT, "lon": LON + 0.001, "tags": {"highway": "bus_stop"}},
]}

YELP = {"businesses": [
    {"name": "Tiny Spot", "rating": 5.0, "review_count": 3, "distance": 500},
    {"name": "Great Diner", "rating": 4.5, "review_count": 800, "price": "$$", "distance": 1609.34,
     "categories": [{"title": "Diners"}], "location": {"display_address": ["1 Main St", "Bryn Mawr, PA"]},
     "coordinates": {"latitude": LAT, "longitude": LON}, "url": "https://yelp.example/great"},
    {"name": "Good Thai", "rating": 4.5, "review_count": 120, "distance": 3000,
     "coordinates": {"latitude": LAT, "longitude": LON}, "url": "https://yelp.example/thai"},
]}

AGENCIES = {"MONTGOMERY": [
    {"ori": "PA0460800", "agency_name": "Lower Merion Township Police Department",
     "agency_type_name": "City", "counties": "MONTGOMERY", "latitude": LAT + 0.01, "longitude": LON},
    {"ori": "PAPSP0000", "agency_name": "Pennsylvania State Police: Norristown",
     "agency_type_name": "State Police", "counties": "MONTGOMERY", "latitude": LAT, "longitude": LON},
    {"ori": "PAFAR0000", "agency_name": "Far Away PD", "latitude": LAT + 2, "longitude": LON},
]}


def _crime_summary(url, params):
    year = params["from"][-4:]
    if year != "2025":
        return {"offenses": {"rates": {}}}
    violent = url.endswith("/V")
    agency = "Pennsylvania State Police: Norristown" if "PAPSP" in url else "Lower Merion Township Police Department"
    agency_rate = 10.0 if violent else 100.0
    return {"offenses": {
        "rates": {
            f"{agency} Offenses": {f"{m:02d}-{year}": agency_rate for m in range(1, 13)},
            f"{agency} Clearances": {f"{m:02d}-{year}": 1.0 for m in range(1, 13)},
            "Pennsylvania Offenses": {f"{m:02d}-{year}": 25.0 if violent else 120.0 for m in range(1, 13)},
            "United States Offenses": {f"{m:02d}-{year}": 30.0 if violent else 160.0 for m in range(1, 13)},
        },
    }}


def fake_get_json(url, params=None, headers=None, ttl=0, method="GET", data=None, **_):
    params = params or {}
    if "zippopotam" in url:
        return {"places": [{"place name": "Bryn Mawr", "latitude": str(LAT),
                            "longitude": str(LON), "state abbreviation": "PA"}]}
    if "geo.fcc.gov" in url:
        return {"results": [{"county_name": "Montgomery County", "county_fips": "42091"}]}
    if "api.census.gov" in url:
        return _acs(url, params)
    if "rentcast" in url:
        assert headers["X-Api-Key"] == "test-rentcast"
        return LISTINGS
    if "project-osrm" in url:
        return _osrm(url, params)
    if "ccd/directory" in url:
        return SCHOOLS
    if "edfacts/assessments" in url:
        return ASSESSMENTS if params.get("ncessch") == "421" else {"results": []}
    if "overpass" in url:
        return OVERPASS
    if "api.yelp.com" in url:
        return YELP
    if "agency/byStateAbbr" in url:
        return AGENCIES
    if "/summarized/agency/" in url:
        return _crime_summary(url, params)
    if "hazards.fema.gov" in url:
        return {"features": [{"attributes": {"FLD_ZONE": "X", "ZONE_SUBTY": "AREA OF MINIMAL FLOOD HAZARD", "SFHA_TF": "F"}}]}
    raise http.SourceError(f"unexpected URL in test: {url}")


@pytest.fixture(autouse=True)
def offline(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(config, "RENTCAST_API_KEY", "test-rentcast")
    monkeypatch.setattr(config, "YELP_API_KEY", "test-yelp")
    monkeypatch.setattr(config, "GREATSCHOOLS_API_KEY", "")
    monkeypatch.setattr(http, "get_json", fake_get_json)
    for mod in ("geo", "sources.census", "sources.listings", "sources.schools",
                "sources.places", "sources.crime", "sources.hazards"):
        module = __import__(f"pa_home_scout.{mod}", fromlist=["get_json"])
        monkeypatch.setattr(module, "get_json", fake_get_json)
    monkeypatch.setattr(zillow, "stream_lines", lambda url, timeout=None: iter(ZILLOW_CSV))
