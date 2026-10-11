"""Build a full neighborhood report for a Pennsylvania ZIP code."""

import datetime as dt
from concurrent.futures import ThreadPoolExecutor

from . import config
from .geo import Location, geocode_zip
from .http import SourceError
from .sources import census, crime, hazards, listings, places, schools, zillow

HOME_INSURANCE_RATE = 0.0045  # ~0.45% of value per year, rough PA average
PMI_RATE = 0.006  # ~0.6% of loan per year when putting down < 20%


def monthly_payment(principal: float, annual_rate_pct: float, years: int) -> float:
    n = years * 12
    r = annual_rate_pct / 100 / 12
    if r == 0:
        return principal / n
    return principal * r / (1 - (1 + r) ** -n)


def estimate_costs(price: float | None, annual_taxes: float | None, tax_rate_pct: float | None,
                   rate_pct: float = config.DEFAULT_MORTGAGE_RATE,
                   down_pct: float = config.DEFAULT_DOWN_PAYMENT_PCT,
                   years: int = config.DEFAULT_LOAN_YEARS) -> dict | None:
    if not price:
        return None
    down = price * down_pct / 100
    loan = price - down
    principal_interest = monthly_payment(loan, rate_pct, years)
    if tax_rate_pct:
        taxes = price * tax_rate_pct / 100 / 12
    elif annual_taxes:
        taxes = annual_taxes / 12
    else:
        taxes = 0
    insurance = price * HOME_INSURANCE_RATE / 12
    pmi = loan * PMI_RATE / 12 if down_pct < 20 else 0
    total = principal_interest + taxes + insurance + pmi
    return {
        "price": round(price),
        "rate_pct": rate_pct,
        "down_pct": down_pct,
        "years": years,
        "down_payment": round(down),
        "loan": round(loan),
        "principal_interest": round(principal_interest),
        "taxes": round(taxes),
        "insurance": round(insurance),
        "pmi": round(pmi),
        "total_monthly": round(total),
        # Common lender guideline: housing cost <= 28% of gross income.
        "income_needed": round(total * 12 / 0.28, -3),
    }


def _section(fn, *args, **kwargs) -> dict:
    try:
        return {"ok": True, "data": fn(*args, **kwargs)}
    except (SourceError, KeyError, IndexError, TypeError, ValueError) as exc:
        return {"ok": False, "error": str(exc)}


def _links(loc: Location) -> dict:
    return {
        **listings.search_links(loc.zip),
        "Walk Score": f"https://www.walkscore.com/score/loc/lat={loc.lat}/lng={loc.lon}",
        "GreatSchools": f"https://www.greatschools.org/search/search.page?lat={loc.lat}&lon={loc.lon}&distance=5",
        "FEMA flood map": f"https://msc.fema.gov/portal/search?AddressQuery={loc.zip}",
        "FBI Crime Data Explorer": "https://cde.ucr.cjis.gov/",
        "Census QuickFacts": f"https://data.census.gov/profile?g=860XX00US{loc.zip}",
    }


def build_report(zip_code: str, max_drive_minutes: int = config.DEFAULT_MAX_DRIVE_MINUTES,
                 rate_pct: float = config.DEFAULT_MORTGAGE_RATE,
                 down_pct: float = config.DEFAULT_DOWN_PAYMENT_PCT) -> dict:
    loc = geocode_zip(zip_code)  # raises ValueError for non-PA zips
    jobs = {
        "demographics": (census.fetch_acs, loc.zip),
        "home_values": (zillow.fetch_zhvi, loc.zip),
        "listings": (listings.fetch_listings, loc.lat, loc.lon, loc.zip, max_drive_minutes),
        "schools": (schools.fetch_schools, loc.lat, loc.lon, loc.county_fips),
        "amenities": (places.fetch_amenities, loc.lat, loc.lon),
        "restaurants": (places.fetch_restaurants, loc.lat, loc.lon),
        "crime": (crime.fetch_crime, loc.lat, loc.lon, loc.county),
        "flood": (hazards.fetch_flood_zone, loc.lat, loc.lon),
    }
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {name: pool.submit(_section, *job) for name, job in jobs.items()}
        sections = {name: f.result() for name, f in futures.items()}

    acs = sections["demographics"].get("data", {}).get("zip", {}) if sections["demographics"]["ok"] else {}
    zhvi = sections["home_values"].get("data") if sections["home_values"]["ok"] else None
    listing_stats = (sections["listings"]["data"]["in_zip_stats"]
                     if sections["listings"]["ok"] else {})
    if zhvi and zhvi.get("typical_home_value"):
        basis, price = "Zillow typical home value", zhvi["typical_home_value"]
    elif listing_stats.get("median_price"):
        basis, price = "median asking price of active listings in this ZIP", listing_stats["median_price"]
    else:
        basis, price = "Census median home value (owner estimate)", acs.get("median_home_value")
    costs = estimate_costs(price, acs.get("median_real_estate_taxes"),
                           acs.get("effective_tax_rate_pct"), rate_pct, down_pct)
    if costs:
        costs["basis"] = basis
        income = acs.get("median_household_income")
        costs["median_income"] = income
        costs["share_of_median_income_pct"] = (
            round(100 * costs["total_monthly"] * 12 / income, 1) if income else None
        )

    return {
        "generated": dt.datetime.now().isoformat(timespec="seconds"),
        "location": loc.to_dict(),
        "max_drive_minutes": max_drive_minutes,
        "sections": sections,
        "costs": costs,
        "pa_notes": hazards.pa_buyer_notes(loc.zip, loc.county),
        "links": _links(loc),
    }
