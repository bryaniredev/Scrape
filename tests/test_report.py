import pytest

from pa_home_scout import geo
from pa_home_scout.http import SourceError
from pa_home_scout.report import build_report, estimate_costs, monthly_payment
from pa_home_scout.sources import listings
from pa_home_scout.web import create_app


def test_pa_zip_validation():
    assert geo.is_pa_zip("19010") and geo.is_pa_zip("15001")
    assert not geo.is_pa_zip("07030") and not geo.is_pa_zip("1901") and not geo.is_pa_zip("abcde")
    with pytest.raises(ValueError):
        geo.geocode_zip("10001")


def test_monthly_payment_matches_standard_amortization():
    # $400k at 6% for 30 years is $2,398.20/month
    assert round(monthly_payment(400_000, 6.0, 30), 2) == 2398.20
    costs = estimate_costs(500_000, None, 1.0, rate_pct=6.0, down_pct=10)
    assert costs["loan"] == 450_000 and costs["pmi"] > 0 and costs["taxes"] == 417


def test_full_report():
    r = build_report("19010")
    s = r["sections"]
    assert all(sec["ok"] for sec in s.values()), {k: v.get("error") for k, v in s.items()}
    assert r["location"]["county_fips"] == "42091"

    z = s["home_values"]["data"]
    assert z["typical_home_value"] == 819000 and z["change_1y_pct"] == 5.0

    acs = s["demographics"]["data"]
    assert acs["year"] == 2024
    assert acs["zip"]["median_age"] is None  # Census sentinel value dropped
    assert acs["zip"]["bachelors_or_higher_pct"] == 35.0
    assert acs["zip"]["effective_tax_rate_pct"] == 1.5
    assert acs["pennsylvania"]["median_home_value"] == 250000

    l = s["listings"]["data"]
    assert l["drive_time_method"] == "osrm"
    assert [h["drive_minutes"] for h in l["homes"]] == [5.0, 15.0]  # 25-min listing excluded
    assert l["in_zip_stats"]["count"] == 1 and l["stats"]["median_price"] == 550000

    sc = s["schools"]["data"]["schools"]
    assert [x["name"] for x in sc] == ["Bryn Mawr Elementary", "Harriton High"]
    assert sc[0]["rating"] == 8 and sc[0]["student_teacher_ratio"] == 15.0
    assert sc[1]["rating"] is None

    cats = s["amenities"]["data"]["categories"]
    assert cats["Grocery stores"]["nearest"][0]["name"] == "Acme"
    assert cats["Bus stops"]["count"] == 1 and cats["Bus stops"]["nearest"] == []
    assert cats["Restaurants"]["nearest"][0]["cuisine"] == "italian, pizza"

    rest = s["restaurants"]["data"]["restaurants"]
    assert [x["name"] for x in rest] == ["Great Diner", "Good Thai"]  # 3-review place dropped

    cr = s["crime"]["data"]
    assert cr["year"] == 2025
    assert cr["agencies"][0]["name"].startswith("Lower Merion")  # local PD before state police
    assert cr["agencies"][0]["violent"] == 120.0 and cr["agencies"][0]["property"] == 1200.0
    assert cr["pennsylvania"] == {"violent": 300.0, "property": 1440.0}
    assert len(cr["agencies"]) == 2  # far agency excluded

    assert s["flood"]["data"]["zone"] == "X"
    assert r["costs"]["basis"].startswith("Zillow") and r["costs"]["price"] == 819000


def test_sections_fail_independently(monkeypatch):
    from pa_home_scout import config

    monkeypatch.setattr(config, "RENTCAST_API_KEY", "")
    monkeypatch.setattr(config, "YELP_API_KEY", "")
    r = build_report("19010")
    assert not r["sections"]["listings"]["ok"] and "RENTCAST_API_KEY" in r["sections"]["listings"]["error"]
    assert not r["sections"]["restaurants"]["ok"]
    assert r["sections"]["schools"]["ok"] and r["links"]["Zillow"].endswith("19010_rb/")


def test_drive_time_falls_back_to_estimate(monkeypatch):
    def boom(*a, **k):
        raise SourceError("down")

    monkeypatch.setattr(listings, "get_json", boom)
    minutes, method = listings.drive_minutes(40.0, -75.0, [(40.1, -75.0)])
    assert method == "estimate" and 10 < minutes[0] < 20  # 6.9 mi * 1.3 at 35 mph


def test_web_pages():
    client = create_app().test_client()
    assert client.get("/").status_code == 200
    page = client.get("/?zip=19010").get_data(as_text=True)
    assert "Bryn Mawr" in page and "$819,000" in page and "Great Diner" in page
    assert "Lower Merion Township Police Department" in page
    bad = client.get("/?zip=10001").get_data(as_text=True)
    assert "not a Pennsylvania zip" in bad
    api = client.get("/api/report?zip=19010")
    assert api.status_code == 200 and api.json["location"]["zip"] == "19010"
    assert client.get("/api/report?zip=99999").status_code == 400
