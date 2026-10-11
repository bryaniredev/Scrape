"""Command line interface: ``python -m pa_home_scout 19103`` or ``... serve``."""

import argparse
import json
import sys

from . import config
from .http import SourceError
from .report import build_report


def money(v):
    return f"${v:,.0f}" if isinstance(v, (int, float)) else "n/a"


def val(v, suffix=""):
    if not isinstance(v, (int, float)):
        return "n/a"
    if float(v).is_integer():
        return f"{int(v):,}{suffix}"
    return f"{v:,.1f}{suffix}"


def _print_section_error(title, section):
    print(f"\n== {title} ==\n  (unavailable: {section['error']})")


def print_report(r: dict) -> None:
    loc, s = r["location"], r["sections"]
    print(f"\nPA Home Scout - {loc['zip']} {loc['place']}, {loc['county'] or 'PA'}")
    print(f"Center: {loc['lat']:.4f}, {loc['lon']:.4f}")

    print("\n== What homes go for ==")
    if s["home_values"]["ok"]:
        z = s["home_values"]["data"]
        print(f"  Zillow typical home value ({z['as_of']}): {money(z['typical_home_value'])}"
              f"  | 1y {val(z['change_1y_pct'], '%')}  | 5y {val(z['change_5y_pct'], '%')}")
    else:
        print(f"  Zillow: unavailable ({s['home_values']['error']})")
    if s["demographics"]["ok"]:
        d = s["demographics"]["data"]
        z, pa = d["zip"], d["pennsylvania"]
        print(f"  Census median home value (ACS {d['year']}): {money(z['median_home_value'])}"
              f" (PA {money(pa.get('median_home_value'))})")
        print(f"  Median rent: {money(z['median_gross_rent'])}   "
              f"Median real-estate taxes: {money(z['median_real_estate_taxes'])}/yr"
              f" (~{val(z['effective_tax_rate_pct'], '%')} of value)")

    c = r.get("costs")
    if c:
        print(f"\n== Estimated monthly cost ({c['basis']}) ==")
        print(f"  {money(c['price'])} at {c['rate_pct']}% with {c['down_pct']:.0f}% down: "
              f"{money(c['total_monthly'])}/mo (P&I {money(c['principal_interest'])}, "
              f"tax {money(c['taxes'])}, ins {money(c['insurance'])}, PMI {money(c['pmi'])})")
        print(f"  Income needed (28% rule): {money(c['income_needed'])}")

    print(f"\n== Homes for sale within {r['max_drive_minutes']} min drive ==")
    if s["listings"]["ok"]:
        l = s["listings"]["data"]
        st = l["stats"]
        note = "" if l["drive_time_method"] == "osrm" else " (drive times estimated)"
        print(f"  {st['count']} listings{note}; median {money(st['median_price'])}, "
              f"{money(st['median_price_per_sqft'])}/sqft, median {val(st['median_days_on_market'])} days on market")
        for h in l["homes"][:15]:
            print(f"  {money(h['price']):>11}  {val(h['beds'])}bd/{val(h['baths'])}ba "
                  f"{val(h['sqft'])}sqft  {h['drive_minutes']:>4} min  {h['address']}")
    else:
        print(f"  (unavailable: {s['listings']['error']})")
    for name, url in list(r["links"].items())[:3]:
        print(f"  {name}: {url}")

    print("\n== Schools ==")
    if s["schools"]["ok"]:
        sc = s["schools"]["data"]
        print(f"  Rating: {sc['rating_label']}")
        for x in sc["schools"]:
            rating = f"{x['rating']}/10" if x.get("rating") is not None else "n/a"
            print(f"  [{rating:>5}] {x['name']} ({x['level']}"
                  f"{', charter' if x.get('charter') else ''}) - {x['miles']} mi")
    else:
        print(f"  (unavailable: {s['schools']['error']})")

    print("\n== Crime (per 100k residents / year) ==")
    if s["crime"]["ok"]:
        cr = s["crime"]["data"]
        for a in cr["agencies"]:
            print(f"  {a['name']} ({a['miles']} mi): violent {val(a.get('violent'))}, "
                  f"property {val(a.get('property'))}")
        print(f"  Pennsylvania: violent {val(cr['pennsylvania']['violent'])}, "
              f"property {val(cr['pennsylvania']['property'])}   ({cr['year']})")
        print(f"  United States: violent {val(cr['united_states']['violent'])}, "
              f"property {val(cr['united_states']['property'])}")
    else:
        print(f"  (unavailable: {s['crime']['error']})")

    print("\n== Top-rated restaurants ==")
    if s["restaurants"]["ok"]:
        for x in s["restaurants"]["data"]["restaurants"][:10]:
            print(f"  {x['rating']}* ({x['reviews']} reviews) {x['name']} {x['price']} - {x['miles']} mi")
    else:
        print(f"  (unavailable: {s['restaurants']['error']})")

    print("\n== Amenities ==")
    if s["amenities"]["ok"]:
        a = s["amenities"]["data"]
        print(f"  Within {a['radius_miles']} miles:")
        for name, info in a["categories"].items():
            if info["nearest_miles"] is None:
                print(f"  {name:<26} {info['count']:>4}")
                continue
            nearest = info["nearest"][0]["name"] if info["nearest"] else ""
            print(f"  {name:<26} {info['count']:>4}   nearest: {info['nearest_miles']} mi {nearest}")
    else:
        print(f"  (unavailable: {s['amenities']['error']})")

    print("\n== Neighborhood ==")
    if s["demographics"]["ok"]:
        z = s["demographics"]["data"]["zip"]
        print(f"  Population {val(z['population'])}, median age {val(z['median_age'])}, "
              f"median household income {money(z['median_household_income'])}")
        print(f"  Owner-occupied {val(z['owner_occupied_pct'], '%')}, vacancy {val(z['vacancy_pct'], '%')}, "
              f"poverty {val(z['poverty_pct'], '%')}, bachelor's+ {val(z['bachelors_or_higher_pct'], '%')}")
        year_built = int(z["median_year_built"]) if z["median_year_built"] else "n/a"
        print(f"  Median year built {year_built}, mean commute {val(z['mean_commute_minutes'])} min")

    print("\n== Flood & PA-specific checks ==")
    if s["flood"]["ok"]:
        f = s["flood"]["data"]
        print(f"  FEMA flood zone at ZIP center: {f['zone'] or 'n/a'} {f['meaning']}")
    for note in r["pa_notes"]:
        print(f"  - {note['title']}: {note['text']}")
    print()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="pa_home_scout", description=__doc__)
    parser.add_argument("zip", help="Pennsylvania ZIP code, or 'serve' to start the web app")
    parser.add_argument("--drive", type=int, default=config.DEFAULT_MAX_DRIVE_MINUTES,
                        help="max drive time in minutes for listings (default 20)")
    parser.add_argument("--rate", type=float, default=config.DEFAULT_MORTGAGE_RATE,
                        help="mortgage rate %% for the cost estimate")
    parser.add_argument("--down", type=float, default=config.DEFAULT_DOWN_PAYMENT_PCT,
                        help="down payment %% for the cost estimate")
    parser.add_argument("--json", action="store_true", help="print raw JSON")
    parser.add_argument("--port", type=int, default=5000, help="port for 'serve'")
    args = parser.parse_args(argv)

    if args.zip == "serve":
        from .web import create_app

        create_app().run(host="127.0.0.1", port=args.port)
        return 0
    try:
        report = build_report(args.zip, args.drive, args.rate, args.down)
    except (ValueError, SourceError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report)
    return 0
