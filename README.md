# PA Home Scout

Enter a Pennsylvania ZIP code and get a one-page briefing for home buyers:

| Section | What you get | Source | Key needed? |
|---|---|---|---|
| What homes go for | Zillow typical home value, 1- and 5-year change, 10-year trend chart; Census median value, rent, property tax, value-to-income ratio | Zillow ZHVI, Census ACS 5-year | No |
| Monthly cost | Mortgage + tax + insurance (+ PMI) estimate, income needed at the 28% rule | Calculated | No |
| Homes for sale | Every active listing within an N-minute **drive** (default 20), with price, beds/baths, sqft, days on market, drive time | RentCast + OSRM routing | `RENTCAST_API_KEY` (free tier) |
| Schools | Nearest elementary/middle/high schools with rating, reading & math proficiency, enrollment, students per teacher | NCES + PA state tests (EDFacts), or GreatSchools | No (GreatSchools optional) |
| Crime | Violent & property crime per 100k for the nearest police departments, vs. PA and US | FBI Crime Data Explorer | Free `DATA_GOV_API_KEY` recommended |
| Restaurants | Best-rated restaurants (25+ reviews) | Yelp | `YELP_API_KEY` (free) |
| Amenities | Counts and nearest grocery, pharmacy, hospital, parks, library, gym, cafes, transit, childcare, etc. | OpenStreetMap | No |
| Neighborhood | Population, income, age, owner-occupancy, vacancy, poverty, education, housing age, commute vs. PA | Census ACS | No |
| Risks & checklist | FEMA flood zone, plus PA-specific notes: transfer tax, radon, mine subsidence, sinkholes, school taxes, wells/septic | FEMA NFHL | No |

Each section is fetched in parallel and fails independently. If a source is down or a key is
missing, the rest of the report still renders and that section says why.

## Website (GitHub Pages)

The `docs/` folder is a browser-only version of the app that runs on GitHub Pages. It needs
no server, because the page calls the data sources directly.

**One-time setup:** in the repo, go to **Settings → Pages → Build and deployment → Source** and
choose **GitHub Actions**. After that, every push to `master` runs the tests, builds the Zillow
data file and deploys the site to `https://<your-user>.github.io/<repo>/`. The workflow also re-runs weekly
to refresh Zillow values. Each search updates the URL (`?zip=19010`), so you can share a link to a report.

What the website shows, and where it comes from:
- **Prebuilt at deploy time** (no browser calls, so no CORS or API keys needed): Zillow home values,
  Census neighborhood profile, ZIP code locations (for "ZIPs within N minutes") and the nearest
  hospitals, urgent care, fire and police stations (OpenStreetMap). The workflow refreshes these weekly.
- **Live from the browser:** schools (NCES), crime (FBI) and the FEMA flood zone. The FBI API is
  rate-limited: without your own key the shared DEMO_KEY allows ~30 requests/hour. A search uses up to
  6 (results are cached in your browser for a week), so add a free api.data.gov key under **API key** if you
  research many ZIPs.
- **Links, filtered for you:** homes for sale on Zillow, Redfin and Realtor.com for your ZIP and every ZIP
  within your drive time, with your max price and minimum beds applied; Google Maps searches for local
  amenities; Google Maps, Yelp and Tripadvisor for restaurants; and Google Maps, Yelp and BBB for home
  services (HVAC, plumbers, electricians, landscaping and more), plus the PA contractor registration lookup.
- Monthly cost updates live as you change the rate or down payment. Each search updates the URL, so a
  report can be shared or bookmarked.

**My homes tab:** save listings and plan a viewing route.
- Add homes by sharing a listing to the site (Android, after *Add to Home screen*), with the
  "+ PA Home Scout" bookmarklet (desktop), or by pasting a Zillow / Redfin / Realtor.com link or an
  address (any device, including iPhone).
- Tick the homes to visit, pick a start (your location, a home, or wherever is most efficient), and
  the site works out the shortest driving order (OpenStreetMap geocoding + OSRM drive times), then opens
  the trip in Google Maps (split into parts of 10 stops, Google's limit per route).
- The list lives in your browser; "Copy list link" moves it to another device.

To preview locally: `python scripts/build_site_data.py && python -m http.server -d docs`.

## Python app setup

```bash
pip install -r requirements.txt
cp .env.example .env        # optional: add API keys
```

## Use it

**Web app** (map, charts, tables):

```bash
python -m pa_home_scout serve        # then open http://127.0.0.1:5000
```

**Command line:**

```bash
python -m pa_home_scout 19010
python -m pa_home_scout 15217 --drive 30 --rate 6.25 --down 10
python -m pa_home_scout 17601 --json > report.json
```

There is also a JSON API: `GET /api/report?zip=19010&drive=20&rate=6.5&down=20`.

## Notes and limitations

- A ZIP is an area, not an address. Flood zone, distances and drive times are measured from the
  ZIP's center. Check the exact address before you make an offer.
- The first run downloads Zillow's ZIP-level CSV (~100 MB) and keeps only the PA rows
  (cached for 7 days in `~/.cache/pa_home_scout`). API responses are cached as well.
- Without a GreatSchools key, the school score is the average % proficient in reading and math
  on PA state tests, divided by 10. It is **not** a GreatSchools rating.
- Crime figures cover each police department's whole jurisdiction. Much of rural PA is policed by
  the State Police, whose figures cover large areas.
- Cost estimates use Census median taxes and a rough insurance rate. Get real quotes, and check the
  school district millage for the exact parcel.

## Tests

```bash
pip install pytest
python -m pytest            # Python app + data builder
node --test tests/site.test.mjs   # browser app (docs/app.js)
```

The tests run offline against recorded API-shaped fixtures.
