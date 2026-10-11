// Node tests for the GitHub Pages app (docs/app.js), with fetch mocked.
import { test } from "node:test";
import assert from "node:assert/strict";

const LAT = 40.0379, LON = -75.346;
const routes = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  for (const [match, body] of routes) {
    if (u.includes(match)) {
      const data = typeof body === "function" ? body(u, opts) : body;
      return { ok: true, status: 200, json: async () => data };
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

routes.push(
  ["zippopotam", { places: [{ "place name": "Bryn Mawr", latitude: String(LAT), longitude: String(LON), "state abbreviation": "PA" }] }],
  ["geo.fcc.gov", { results: [{ county_name: "Montgomery County", county_fips: "42091" }] }],
  ["acs5/profile", (u) => [["DP03_0025E", "x"], ["29.1", "1"]]],
  ["api.census.gov", (u) => {
    const names = new URL(u).searchParams.get("get").split(",");
    const vals = { B25077_001E: "760000", B19013_001E: "145000", B25103_001E: "11400", B01002_001E: "-666666666",
      B15003_001E: "1000", B15003_022E: "200", B15003_023E: "100", B15003_024E: "30", B15003_025E: "20" };
    return [names, names.map((n) => vals[n] ?? "100")];
  }],
  ["data/zhvi_pa.json", { zips: { 19010: { start: "2025-08", values: [780000, 790000, null, 800000, 805000, 806000, 807000, 808000, 810000, 812000, 815000, 817000, 819000], metro: "Philadelphia" } } }],
  ["api.rentcast.io", [
    { formattedAddress: "1 Elm St", zipCode: "19010", price: 650000, squareFootage: 1800, daysOnMarket: 12, latitude: LAT + 0.01, longitude: LON },
    { formattedAddress: "9 Oak Ave", zipCode: "19003", price: 450000, squareFootage: 1200, daysOnMarket: 30, latitude: LAT, longitude: LON + 0.03 },
    { formattedAddress: "Far Rd", zipCode: "19355", price: 900000, latitude: LAT + 0.1, longitude: LON - 0.2 },
  ]],
  ["project-osrm", (u) => { const n = u.split("?")[0].split(";").length - 1; return { code: "Ok", durations: [[0, ...Array.from({ length: n }, (_, i) => (5 + 10 * i) * 60)]] }; }],
  ["ccd/directory", { next: null, results: [
    { ncessch: "421", school_name: "Bryn Mawr Elementary", school_level: 1, lowest_grade_offered: 0, highest_grade_offered: 5, school_status: 1, virtual: 0, enrollment: 450, teachers_fte: 30, latitude: LAT + 0.005, longitude: LON },
    { ncessch: "423", school_name: "Closed", school_level: 1, school_status: 2, latitude: LAT, longitude: LON },
    { ncessch: "424", school_name: "Cyber Charter", school_level: 3, school_status: 1, virtual: 1, latitude: LAT, longitude: LON },
  ] }],
  ["edfacts/assessments", (u) => (u.includes("ncessch=421") ? { results: [
    { race: 1, sex: 99, read_test_pct_prof_midpt: 10, math_test_pct_prof_midpt: 10 },
    { race: 99, sex: 99, read_test_pct_prof_midpt: 82.5, math_test_pct_prof_midpt: 74.5 },
  ] } : { results: [] })],
  ["overpass", { elements: [
    { lat: LAT + 0.004, lon: LON, tags: { shop: "supermarket", name: "Acme" } },
    { center: { lat: LAT + 0.01, lon: LON }, tags: { leisure: "park", name: "Ashbridge Park" } },
    { lat: LAT, lon: LON + 0.002, tags: { amenity: "restaurant", name: "Tavola", cuisine: "italian;pizza" } },
  ] }],
  ["agency/byStateAbbr", { MONTGOMERY: [
    { ori: "PA0460800", agency_name: "Lower Merion Township Police Department", latitude: LAT + 0.01, longitude: LON },
    { ori: "PAPSP0000", agency_name: "Pennsylvania State Police: Norristown", latitude: LAT, longitude: LON },
  ] }],
  ["/summarized/agency/", (u) => {
    const year = new URL(u).searchParams.get("from").slice(-4);
    if (year !== String(new Date().getFullYear() - 1)) return { offenses: { rates: {} } };
    const v = u.includes("/V?");
    const name = u.includes("PAPSP") ? "Pennsylvania State Police: Norristown" : "Lower Merion Township Police Department";
    const months = (x) => Object.fromEntries(Array.from({ length: 12 }, (_, m) => [`${String(m + 1).padStart(2, "0")}-${year}`, x]));
    return { offenses: { rates: { [`${name} Offenses`]: months(v ? 10 : 100), "Pennsylvania Offenses": months(v ? 25 : 120), "United States Offenses": months(v ? 30 : 160) } } };
  }],
  ["hazards.fema.gov", { features: [{ attributes: { FLD_ZONE: "AE", SFHA_TF: "T" } }] }],
);

const app = await import("../docs/app.js");

test("PA zip validation and geocoding", async () => {
  assert.ok(app.isPaZip("19010") && !app.isPaZip("07030") && !app.isPaZip("1901"));
  await assert.rejects(app.geocode("10001"), /not a Pennsylvania ZIP/);
  const loc = await app.geocode("19010");
  assert.equal(loc.countyFips, "42091");
});

test("mortgage math", () => {
  assert.equal(app.monthlyPayment(400000, 6, 30).toFixed(2), "2398.20");
  const c = app.estimateCosts(500000, 1.0, null, 6, 10);
  assert.equal(c.taxes, 417);
  assert.ok(c.pmi > 0);
});

test("zillow summary handles gaps by date", async () => {
  const z = await app.fetchZhvi("19010");
  assert.equal(z.value, 819000);
  assert.equal(z.asOf, "2026-08");
  assert.equal(z.change1y, 5);
  await assert.rejects(app.fetchZhvi("19103"), /does not publish/);
});

test("census", async () => {
  const acs = await app.fetchAcs("19010", {});
  assert.equal(acs.year, 2024);
  assert.equal(acs.zip.medianAge, null);
  assert.equal(acs.zip.degreePct, 35);
  assert.equal(acs.zip.commuteMinutes, 29.1);
});

test("listings filtered by drive time", async () => {
  const loc = await app.geocode("19010");
  await assert.rejects(app.fetchListings(loc, 20, {}), /RentCast/);
  const l = await app.fetchListings(loc, 20, { rentcast: "k" });
  assert.deepEqual(l.homes.map((h) => h.drive), [5, 15]);
  assert.equal(l.inZip.count, 1);
  assert.equal(l.stats.median, 550000);
});

test("schools skip closed and virtual, rate by proficiency", async () => {
  const s = await app.fetchSchools(await app.geocode("19010"));
  assert.deepEqual(s.schools.map((x) => x.name), ["Bryn Mawr Elementary"]);
  assert.equal(s.schools[0].rating, 8);
  assert.equal(s.schools[0].grades, "K-5");
});

test("amenities", async () => {
  const a = await app.fetchAmenities(await app.geocode("19010"));
  assert.equal(a.categories["Grocery stores"].nearest[0].name, "Acme");
  assert.equal(a.categories.Restaurants.nearest[0].cuisine, "italian, pizza");
});

test("crime prefers local police and compares to PA", async () => {
  const c = await app.fetchCrime(await app.geocode("19010"), {});
  assert.match(c.agencies[0].name, /Lower Merion/);
  assert.equal(c.agencies[0].violent, 120);
  assert.deepEqual(c.pa, { violent: 300, property: 1440 });
});

test("flood and escaping", async () => {
  const f = await app.fetchFlood(await app.geocode("19010"));
  assert.equal(f.zone, "AE");
  assert.equal(app.esc('<img src=x onerror="a">'), "&lt;img src=x onerror=&quot;a&quot;&gt;");
});
