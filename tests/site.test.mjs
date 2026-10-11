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

const ACS_ROW = { medianHomeValue: 760000, medianIncome: 145000, medianTaxes: 11400, medianAge: null,
  pop25: 1000, bachelors: 200, masters: 100, professional: 30, doctorate: 20, occupied: 100, ownerOccupied: 72, commuteMinutes: 29.1 };

routes.push(
  ["zippopotam", { places: [{ "place name": "Bryn Mawr", latitude: String(LAT), longitude: String(LON), "state abbreviation": "PA" }] }],
  ["geo.fcc.gov", { results: [{ county_name: "Montgomery County", county_fips: "42091" }] }],
  ["data/acs_pa.json", { year: 2024, zips: { 19010: ACS_ROW }, pa: { medianHomeValue: 250000, occupied: 100, ownerOccupied: 69 } }],
  ["data/zhvi_pa.json", { zips: {
    19010: { start: "2025-08", values: [780000, 790000, null, 800000, 805000, 806000, 807000, 808000, 810000, 812000, 815000, 817000, 819000], metro: "Philadelphia" },
    19003: { start: "2026-07", values: [500000, 510000] },
  } }],
  ["data/zcta_pa.json", {
    19010: [LAT, LON, "Bryn Mawr"],
    19003: [LAT, LON + 0.03, "Ardmore"],        // ~1.6 mi -> ~4 min
    19355: [LAT + 0.1, LON - 0.2, "Malvern"],    // ~12.5 mi -> ~28 min
  }],
  ["data/emergency_pa.json", {
    hospital: [[LAT + 0.2, LON, "Far Hospital", "", 1], [LAT + 0.01, LON, "Bryn Mawr Hospital", "130 S Bryn Mawr Ave, Bryn Mawr", 1]],
    urgent: [], fire: [[LAT, LON + 0.01, "Bryn Mawr Fire Co", ""]], police: [],
  }],
  ["ccd/directory", { next: null, results: [
    { ncessch: "421", school_name: "Bryn Mawr Elementary", school_level: 1, lowest_grade_offered: 0, highest_grade_offered: 5, school_status: 1, virtual: 0, enrollment: 450, teachers_fte: 30, latitude: LAT + 0.005, longitude: LON },
    { ncessch: "423", school_name: "Closed", school_level: 1, school_status: 2, latitude: LAT, longitude: LON },
    { ncessch: "424", school_name: "Cyber Charter", school_level: 3, school_status: 1, virtual: 1, latitude: LAT, longitude: LON },
  ] }],
  ["edfacts/assessments", (u) => (u.includes("ncessch=421") ? { results: [
    { race: 1, sex: 99, read_test_pct_prof_midpt: 10, math_test_pct_prof_midpt: 10 },
    { race: 99, sex: 99, read_test_pct_prof_midpt: 82.5, math_test_pct_prof_midpt: 74.5 },
  ] } : { results: [] })],
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

test("census comes from the prebuilt file", async () => {
  const acs = await app.fetchAcs("19010");
  assert.equal(acs.year, 2024);
  assert.equal(acs.zip.medianAge, null);
  assert.equal(acs.zip.degreePct, 35);
  assert.equal(acs.zip.ownerPct, 72);
  assert.equal(acs.pa.ownerPct, 69);
  await assert.rejects(app.fetchAcs("19099"), /doesn't publish/);
});

test("home search links carry the filters", () => {
  const l = app.homeSearchLinks("19010", { maxPrice: 500000, minBeds: 3 });
  assert.equal(l.Zillow, "https://www.zillow.com/homes/for_sale/19010_rb/3-_beds/0-500000_price/");
  assert.equal(l.Redfin, "https://www.redfin.com/zipcode/19010/filter/min-beds=3,max-price=500k");
  assert.equal(l["Realtor.com"], "https://www.realtor.com/realestateandhomes-search/19010/beds-3/price-na-500000");
  assert.equal(app.homeSearchLinks("19010", { maxPrice: 1250000 }).Redfin, "https://www.redfin.com/zipcode/19010/filter/max-price=1.25M");
  assert.equal(app.homeSearchLinks("19010").Redfin, "https://www.redfin.com/zipcode/19010");
});

test("nearby ZIPs are limited by estimated drive time", async () => {
  const loc = await app.geocode("19010");
  const z = await app.nearbyZips(loc, 20);
  assert.deepEqual(z.map((x) => x.zip), ["19010", "19003"]);
  assert.equal(z[0].value, 819000);
  assert.equal(z[1].city, "Ardmore");
  assert.equal((await app.nearbyZips(loc, 30)).length, 3);
});

test("nearest emergency services", async () => {
  const loc = await app.geocode("19010");
  const em = await app.fetchEmergency(loc);
  assert.equal(em.hospital[0].name, "Bryn Mawr Hospital");
  assert.ok(em.hospital[0].er && em.hospital[0].miles < 1);
  assert.equal(em.hospital.length, 2);
  assert.deepEqual(em.urgent, []);
  assert.match(app.directionsUrl(loc, 40, -75), /google\.com\/maps\/dir\/\?api=1&origin=40\.0379%2C-75\.346&destination=40%2C-75/);
});

test("link builders encode the query", () => {
  assert.equal(app.mapsSearch("grocery store", "19010"), "https://www.google.com/maps/search/grocery%20store%20near%2019010%2C%20PA");
  assert.match(app.yelpSearch("Plumbers", "19010"), /find_desc=Plumbers&find_loc=19010%2C\+PA&sortby=rating/);
  assert.match(app.bbbSearch("plumber", "19010"), /find_text=plumber&find_loc=19010/);
});

test("schools skip closed and virtual, rate by proficiency", async () => {
  const s = await app.fetchSchools(await app.geocode("19010"));
  assert.deepEqual(s.schools.map((x) => x.name), ["Bryn Mawr Elementary"]);
  assert.equal(s.schools[0].rating, 8);
  assert.equal(s.schools[0].grades, "K-5");
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

test("safety links include Ring Neighbors", () => {
  assert.equal(app.SAFETY_LINKS["Ring Neighbors"], "https://neighbors.ring.com/");
});
