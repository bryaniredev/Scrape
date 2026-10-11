import importlib.util
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("build_site_data", SCRIPTS / "build_site_data.py")
bsd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bsd)


def test_parse_acs_keeps_names_and_drops_sentinels():
    rows = [
        ["B25077_001E", "B01002_001E", "zip code tabulation area"],
        ["760000", "-666666666", "19010"],
        ["300000", "41.5", "07030"],
    ]
    out = bsd.parse_acs(rows, bsd.ACS_DETAIL, "zip code tabulation area")
    assert out["19010"] == {"medianHomeValue": 760000, "medianAge": None}
    assert out["07030"]["medianAge"] == 41.5


def test_build_acs_filters_to_pa(monkeypatch):
    def fake(year, dataset, variables, geo):
        col = "state" if geo.startswith("state") else "zip code tabulation area"
        ids = ["42"] if col == "state" else ["19010", "07030", "15001"]
        names = list(variables)
        return [names + [col]] + [["1"] * len(names) + [i] for i in ids]

    monkeypatch.setattr(bsd, "_census", fake)
    data = bsd.build_acs_census()
    assert data["year"] == 2024
    assert sorted(data["zips"]) == ["15001", "19010"]
    assert data["zips"]["19010"]["commuteMinutes"] == 1 and data["pa"]["population"] == 1


def test_parse_gazetteer():
    text = ("GEOID\tALAND\tAWATER\tALAND_SQMI\tAWATER_SQMI\tINTPTLAT\tINTPTLONG                                                                                                               \n"
            "19010\t1\t1\t1\t1\t40.023456\t-75.329876\n"
            "07030\t1\t1\t1\t1\t40.74\t-74.03\n")
    assert bsd.parse_gazetteer(text) == {"19010": [40.02346, -75.32988]}


def test_parse_emergency():
    data = {"elements": [
        {"lat": 40.03, "lon": -75.32, "tags": {"amenity": "hospital", "name": "Bryn Mawr Hospital", "emergency": "yes",
                                              "addr:housenumber": "130", "addr:street": "S Bryn Mawr Ave", "addr:city": "Bryn Mawr"}},
        {"center": {"lat": 40.0, "lon": -75.3}, "tags": {"amenity": "fire_station", "name": "Station 1"}},
        {"lat": 40.1, "lon": -75.1, "tags": {"healthcare": "urgent_care"}},
        {"lat": 40.1, "lon": -75.1, "tags": {"amenity": "police", "name": "PD"}},
        {"lat": 40.1, "lon": -75.1, "tags": {"amenity": "cafe"}},
    ]}
    out = bsd.parse_emergency(data)
    assert out["hospital"] == [[40.03, -75.32, "Bryn Mawr Hospital", "130 S Bryn Mawr Ave, Bryn Mawr", 1]]
    assert out["fire"] == [[40.0, -75.3, "Station 1", ""]]
    assert len(out["urgent"]) == 1 and len(out["police"]) == 1


def test_census_reporter_fallback(monkeypatch):
    def census_down(*a, **k):
        raise ValueError("HTTP 200, not JSON: '<html>Invalid Key</html>'")

    class Resp:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            pass

        def json(self):
            return self.payload

    def fake_get(url, params, headers, timeout):
        table = params["table_ids"]
        if table == "B08303":  # a table the API rejects is skipped, not fatal
            raise bsd.requests.HTTPError("400 Client Error: Bad Request")
        cols = bsd.REPORTER_TABLES[table]
        est = {c: 100 for c in cols}
        if table == "B08013":
            est = {"B08013001": 2910}
        return Resp({"release": {"id": "acs2023_5yr"}, "data": {
            "86000US19010": {table: {"estimate": est}},
            "86000US07030": {table: {"estimate": est}},
            "04000US42": {table: {"estimate": est}},
        }})

    monkeypatch.setattr(bsd, "_census", census_down)
    monkeypatch.setattr(bsd.requests, "get", fake_get)
    data = bsd.build_acs()
    assert data["year"] == 2023 and data["source"] == "Census Reporter"
    assert list(data["zips"]) == ["19010"]
    row = data["zips"]["19010"]
    assert row["medianHomeValue"] == 100 and row["commuteMinutes"] is None
    assert "_travelTime" not in row and data["pa"]["population"] == 100


def test_main_keeps_previous_copy_when_a_source_is_down(monkeypatch, tmp_path):
    def down():
        raise RuntimeError("Overpass unavailable")

    monkeypatch.setattr(bsd.zillow, "_load_pa_rows", lambda: {"19010": {"series": [("2026-08-31", 1)], "city": "Bryn Mawr"}})
    monkeypatch.setattr(bsd, "build_acs", lambda: {"zips": {}})
    monkeypatch.setattr(bsd, "build_zcta", lambda rows: {"19010": [40, -75, rows["19010"]["city"]]})
    monkeypatch.setattr(bsd, "build_emergency", down)
    monkeypatch.setattr(bsd, "build_agencies", lambda: [["PA1", "PD", 40.0, -75.0]])
    monkeypatch.setattr(bsd, "previous_copy", lambda name: {"hospital": [[1, 2, "Kept", ""]]})
    assert bsd.main(str(tmp_path)) == 0
    import json
    assert json.loads((tmp_path / "emergency_pa.json").read_text())["hospital"][0][2] == "Kept"
    assert json.loads((tmp_path / "zcta_pa.json").read_text())["19010"][2] == "Bryn Mawr"


def test_parse_agencies():
    data = {"MONTGOMERY": [
        {"ori": "PA0460800", "agency_name": "Lower Merion Township Police Department", "latitude": 40.0123456, "longitude": "-75.3"},
        {"ori": "PA0000000", "agency_name": "No location"},
    ], "OTHER": "unexpected"}
    assert bsd.parse_agencies(data) == [["PA0460800", "Lower Merion Township Police Department", 40.01235, -75.3]]
