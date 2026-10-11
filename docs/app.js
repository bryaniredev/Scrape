// PA Home Scout - browser version. Runs entirely client-side so it can be
// hosted on GitHub Pages; every data source is called directly from the page.

const KEY_STORE = "pa-home-scout-keys";
const EARTH_RADIUS_MILES = 3958.8;
const SCHOOL_RADIUS_MILES = 5;
const AMENITY_RADIUS_M = 3000;
const HOME_INSURANCE_RATE = 0.0045;
const PMI_RATE = 0.006;

// ---------------------------------------------------------------- utilities

export class SourceError extends Error {}

const cache = new Map();

export async function getJSON(url, { params, headers, method = "GET", body, timeout = 30000 } = {}) {
  const full = params ? `${url}?${new URLSearchParams(params)}` : url;
  const cacheKey = `${method} ${full} ${body || ""}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let resp;
  try {
    resp = await fetch(full, { method, headers, body, signal: ctrl.signal });
  } catch (err) {
    throw new SourceError(`${new URL(url).host} unreachable (${err.name === "AbortError" ? "timed out" : "network or CORS error"})`);
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new SourceError(`${new URL(url).host} returned HTTP ${resp.status}`);
  let data;
  try { data = await resp.json(); } catch { throw new SourceError(`${new URL(url).host} did not return JSON`); }
  cache.set(cacheKey, data);
  return data;
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dp = rad(lat2 - lat1), dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

const round = (v, d = 0) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function isPaZip(zip) {
  return /^\d{5}$/.test(zip || "") && +zip >= 15000 && +zip <= 19699;
}

export function loadKeys() {
  try { return JSON.parse(localStorage.getItem(KEY_STORE)) || {}; } catch { return {}; }
}
function saveKeys(keys) {
  try { localStorage.setItem(KEY_STORE, JSON.stringify(keys)); return true; } catch { return false; }
}

// ---------------------------------------------------------------- location

export async function geocode(zip) {
  if (!isPaZip(zip)) throw new Error(`"${zip}" is not a Pennsylvania ZIP code (PA ZIPs run 15001-19640).`);
  let data;
  try {
    data = await getJSON(`https://api.zippopotam.us/us/${zip}`);
  } catch (err) {
    throw new Error(`Couldn't find ZIP ${zip}: ${err.message}`);
  }
  const place = data.places?.[0];
  if (!place) throw new Error(`Couldn't find ZIP ${zip}.`);
  if (place["state abbreviation"] !== "PA") throw new Error(`${zip} is in ${place["state abbreviation"]}, not Pennsylvania.`);
  const loc = { zip, lat: +place.latitude, lon: +place.longitude, place: place["place name"], county: "", countyFips: "" };
  try {
    const fcc = await getJSON("https://geo.fcc.gov/api/census/area", {
      params: { lat: loc.lat, lon: loc.lon, censusYear: 2020, format: "json" },
    });
    loc.county = fcc.results[0].county_name;
    loc.countyFips = fcc.results[0].county_fips;
  } catch { /* county is only needed for schools; that section will say so */ }
  return loc;
}

// ---------------------------------------------------------------- Census ACS

const ACS_YEARS = [2024, 2023, 2022];
const DETAIL_VARS = {
  B25077_001E: "medianHomeValue", B25064_001E: "medianRent", B19013_001E: "medianIncome",
  B01003_001E: "population", B01002_001E: "medianAge", B25003_001E: "occupied",
  B25003_002E: "ownerOccupied", B25002_001E: "housingUnits", B25002_003E: "vacant",
  B25035_001E: "medianYearBuilt", B25103_001E: "medianTaxes", B17001_001E: "povertyUniverse",
  B17001_002E: "belowPoverty", B15003_001E: "pop25", B15003_022E: "bachelors",
  B15003_023E: "masters", B15003_024E: "professional", B15003_025E: "doctorate",
};
const PROFILE_VARS = { DP03_0025E: "commuteMinutes" };

const acsNum = (v) => { const n = parseFloat(v); return Number.isNaN(n) || n < -1 ? null : n; };

async function acsQuery(year, dataset, vars, geo, key) {
  const params = { get: Object.keys(vars).join(","), for: geo };
  if (key) params.key = key;
  const rows = await getJSON(`https://api.census.gov/data/${year}/${dataset}`, { params });
  if (!Array.isArray(rows) || rows.length < 2) throw new SourceError(`no ACS ${year} data`);
  const out = {};
  rows[0].forEach((name, i) => { if (vars[name]) out[vars[name]] = acsNum(rows[1][i]); });
  return out;
}

export function deriveAcs(raw) {
  const pct = (n, d) => (n == null || !d ? null : round((100 * n) / d, 1));
  const deg = [raw.bachelors, raw.masters, raw.professional, raw.doctorate];
  return {
    ...raw,
    ownerPct: pct(raw.ownerOccupied, raw.occupied),
    vacancyPct: pct(raw.vacant, raw.housingUnits),
    povertyPct: pct(raw.belowPoverty, raw.povertyUniverse),
    degreePct: deg.every((x) => x != null) ? pct(deg.reduce((a, b) => a + b, 0), raw.pop25) : null,
    priceToIncome: raw.medianHomeValue && raw.medianIncome ? round(raw.medianHomeValue / raw.medianIncome, 1) : null,
    taxRatePct: raw.medianTaxes && raw.medianHomeValue ? round((100 * raw.medianTaxes) / raw.medianHomeValue, 2) : null,
  };
}

async function acsFor(geo, key) {
  const errors = [];
  for (const year of ACS_YEARS) {
    let raw;
    try { raw = await acsQuery(year, "acs/acs5", DETAIL_VARS, geo, key); } catch (e) { errors.push(e.message); continue; }
    try { Object.assign(raw, await acsQuery(year, "acs/acs5/profile", PROFILE_VARS, geo, key)); } catch { raw.commuteMinutes = null; }
    return { year, data: deriveAcs(raw) };
  }
  throw new SourceError(`Census ACS unavailable: ${errors.join("; ")}`);
}

export async function fetchAcs(zip, keys) {
  const [area, state] = await Promise.all([
    acsFor(`zip code tabulation area:${zip}`, keys.census),
    acsFor("state:42", keys.census).catch(() => ({ data: {} })),
  ]);
  return { year: area.year, zip: area.data, pa: state.data };
}

// ---------------------------------------------------------------- Zillow (prebuilt JSON)

let zhviPromise;
export async function fetchZhvi(zip) {
  zhviPromise ??= getJSON("data/zhvi_pa.json").catch((e) => { zhviPromise = null; throw e; });
  let data;
  try { data = await zhviPromise; } catch { throw new SourceError("Zillow data file not built yet (it's generated when the site deploys)."); }
  const entry = data.zips?.[zip];
  if (!entry) throw new SourceError(`Zillow does not publish a home value index for ${zip}.`);
  return summarizeZhvi(entry);
}

export function monthAdd(ym, n) {
  const t = +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1) + n;
  return `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export function summarizeZhvi(entry) {
  // entry: { start: "YYYY-MM", values: [number|null, ...] (monthly), metro }
  const series = entry.values.map((v, i) => [monthAdd(entry.start, i), v]).filter(([, v]) => v != null);
  if (!series.length) throw new SourceError("no Zillow values for this ZIP");
  const [asOf, latest] = series.at(-1);
  const valueAt = (ym) => series.find(([d]) => d === ym)?.[1] ?? null;
  const change = (then) => (then ? round((100 * (latest - then)) / then, 1) : null);
  return {
    asOf, value: latest, metro: entry.metro,
    change1y: change(valueAt(monthAdd(asOf, -12))),
    change5y: change(valueAt(monthAdd(asOf, -60))),
    history: series.slice(-120),
  };
}

// ---------------------------------------------------------------- listings

export function estimateMinutes(lat, lon, pLat, pLon) {
  return round(((haversineMiles(lat, lon, pLat, pLon) * 1.3) / 35) * 60, 1);
}

export async function driveMinutes(lat, lon, points) {
  if (!points.length) return { minutes: [], method: "osrm" };
  try {
    const minutes = [];
    for (let i = 0; i < points.length; i += 90) {
      const chunk = points.slice(i, i + 90);
      const coords = [[lat, lon], ...chunk].map(([a, o]) => `${o.toFixed(6)},${a.toFixed(6)}`).join(";");
      const data = await getJSON(`https://router.project-osrm.org/table/v1/driving/${coords}`, {
        params: { sources: 0, annotations: "duration" },
      });
      if (data.code !== "Ok") throw new SourceError(`OSRM ${data.code}`);
      minutes.push(...data.durations[0].slice(1).map((d) => (d == null ? null : round(d / 60, 1))));
    }
    return { minutes, method: "osrm" };
  } catch {
    return { minutes: points.map(([a, o]) => estimateMinutes(lat, lon, a, o)), method: "estimate" };
  }
}

export function listingStats(homes) {
  const prices = homes.map((h) => h.price).filter(isNum);
  const ppsf = homes.filter((h) => h.price && h.sqft).map((h) => h.price / h.sqft);
  const dom = homes.map((h) => h.dom).filter(isNum);
  return {
    count: homes.length,
    median: round(median(prices)), min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    ppsf: round(median(ppsf)), dom: round(median(dom)),
  };
}

export async function fetchListings(loc, maxMinutes, keys) {
  if (!keys.rentcast) {
    throw new SourceError("Add a RentCast API key (free tier) under “API keys” to list homes for sale here. Meanwhile, use the search links below.");
  }
  const raw = await getJSON("https://api.rentcast.io/v1/listings/sale", {
    params: { latitude: loc.lat, longitude: loc.lon, radius: Math.max(5, maxMinutes), status: "Active", limit: 500 },
    headers: { "X-Api-Key": keys.rentcast, Accept: "application/json" },
  });
  if (!Array.isArray(raw)) throw new SourceError("unexpected RentCast response");
  const homes = raw
    .filter((i) => i.latitude != null && i.longitude != null)
    .map((i) => ({
      address: i.formattedAddress || i.addressLine1, zip: i.zipCode, price: i.price,
      beds: i.bedrooms, baths: i.bathrooms, sqft: i.squareFootage, built: i.yearBuilt,
      type: i.propertyType, dom: i.daysOnMarket, lat: i.latitude, lon: i.longitude,
    }));
  const { minutes, method } = await driveMinutes(loc.lat, loc.lon, homes.map((h) => [h.lat, h.lon]));
  homes.forEach((h, i) => { h.drive = minutes[i]; });
  const within = homes.filter((h) => h.drive != null && h.drive <= maxMinutes)
    .sort((a, b) => a.drive - b.drive || (a.price || 0) - (b.price || 0));
  return { method, homes: within, stats: listingStats(within), inZip: listingStats(within.filter((h) => h.zip === loc.zip)) };
}

export function searchLinks(loc) {
  return {
    Zillow: `https://www.zillow.com/homes/for_sale/${loc.zip}_rb/`,
    Redfin: `https://www.redfin.com/zipcode/${loc.zip}`,
    "Realtor.com": `https://www.realtor.com/realestateandhomes-search/${loc.zip}`,
  };
}

// ---------------------------------------------------------------- schools

const URBAN = "https://educationdata.urban.org/api/v1/schools";
const LEVELS = { 0: "Pre-K", 1: "Elementary", 2: "Middle", 3: "High", 4: "Other" };
const GRADE_NAMES = { "-1": "PK", 0: "K" };
const CLOSED = new Set([2, 6, 7]);

async function urbanPages(url, params) {
  const out = [];
  let next = url, p = params;
  for (let i = 0; i < 20 && next; i++) {
    const data = await getJSON(next, { params: p });
    out.push(...(data.results || []));
    next = data.next; p = undefined;
  }
  return out;
}

export function isTotalRow(row) {
  return ["race", "sex", "lep", "homeless", "migrant", "disability", "econ_disadvantaged", "foster_care", "military_connected"]
    .every((k) => !(k in row) || row[k] === 99 || row[k] == null);
}

async function proficiency(ncessch) {
  for (const year of [2022, 2021, 2018]) {
    let rows;
    try { rows = (await getJSON(`${URBAN}/edfacts/assessments/${year}/grade-99/`, { params: { ncessch } })).results || []; } catch { continue; }
    for (const row of rows) {
      if (!isTotalRow(row)) continue;
      const read = isNum(row.read_test_pct_prof_midpt) && row.read_test_pct_prof_midpt >= 0 ? row.read_test_pct_prof_midpt : null;
      const math = isNum(row.math_test_pct_prof_midpt) && row.math_test_pct_prof_midpt >= 0 ? row.math_test_pct_prof_midpt : null;
      const vals = [read, math].filter((v) => v != null);
      if (vals.length) {
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        return { year, read, math, score: Math.max(1, Math.min(10, Math.round(avg / 10))) };
      }
    }
  }
  return null;
}

function grades(lo, hi) {
  if (lo == null || hi == null || lo < -1 || hi < -1) return "";
  return `${GRADE_NAMES[lo] ?? lo}-${GRADE_NAMES[hi] ?? hi}`;
}

export async function fetchSchools(loc) {
  if (!loc.countyFips) throw new SourceError("County unknown, so schools can't be looked up.");
  let rows = [], year;
  for (year of [2023, 2022, 2021]) {
    try { rows = await urbanPages(`${URBAN}/ccd/directory/${year}/`, { fips: 42, county_code: loc.countyFips }); } catch { continue; }
    if (rows.length) break;
  }
  if (!rows.length) throw new SourceError("School directory (Urban Institute Education Data API) unavailable.");
  const schools = rows
    .filter((r) => r.latitude != null && r.longitude != null && !CLOSED.has(r.school_status) && [0, -1, -2, null, undefined].includes(r.virtual))
    .map((r) => ({
      id: String(r.ncessch), name: r.school_name, district: r.lea_name,
      level: LEVELS[r.school_level] || "Other", grades: grades(r.lowest_grade_offered, r.highest_grade_offered),
      charter: r.charter === 1, enrollment: r.enrollment > 0 ? r.enrollment : null,
      ratio: r.enrollment > 0 && r.teachers_fte > 0 ? round(r.enrollment / r.teachers_fte, 1) : null,
      lat: r.latitude, lon: r.longitude, miles: round(haversineMiles(loc.lat, loc.lon, r.latitude, r.longitude), 1),
    }))
    .filter((s) => s.miles <= SCHOOL_RADIUS_MILES)
    .sort((a, b) => a.miles - b.miles);
  const perLevel = {}, picked = [];
  for (const s of schools) {
    if ((perLevel[s.level] = (perLevel[s.level] || 0) + 1) <= 6) picked.push(s);
  }
  const profs = await Promise.all(picked.map((s) => proficiency(s.id)));
  picked.forEach((s, i) => { s.prof = profs[i]; s.rating = profs[i]?.score ?? null; });
  return { year, schools: picked };
}

// ---------------------------------------------------------------- amenities (OpenStreetMap)

export const CATEGORIES = {
  "Grocery stores": [["shop", "^(supermarket|grocery|greengrocer)$"]],
  Pharmacies: [["amenity", "^pharmacy$"]],
  "Hospitals & clinics": [["amenity", "^(hospital|clinic)$"], ["healthcare", "^urgent_care$"]],
  "Parks & playgrounds": [["leisure", "^(park|playground|nature_reserve)$"]],
  Libraries: [["amenity", "^library$"]],
  "Gyms & rec centers": [["leisure", "^(fitness_centre|sports_centre)$"]],
  "Coffee shops": [["amenity", "^cafe$"]],
  Restaurants: [["amenity", "^(restaurant|fast_food)$"]],
  "Bars & pubs": [["amenity", "^(bar|pub)$"]],
  "Childcare & preschools": [["amenity", "^(childcare|kindergarten)$"]],
  "Train & subway stations": [["railway", "^(station|halt)$"]],
  "Bus stops": [["highway", "^bus_stop$"]],
  Banks: [["amenity", "^bank$"]],
  "Gas stations": [["amenity", "^fuel$"]],
  "Post offices": [["amenity", "^post_office$"]],
  "Places of worship": [["amenity", "^place_of_worship$"]],
};

export function overpassQuery(lat, lon, radius) {
  const filters = new Set(Object.values(CATEGORIES).flat().map(([k, v]) => `${k}|${v}`));
  const parts = [...filters].sort().map((f) => { const [k, v] = f.split("|"); return `nwr(around:${radius},${lat},${lon})["${k}"~"${v}"];`; }).join("");
  return `[out:json][timeout:60];(${parts});out center tags;`;
}

function categoryOf(tags) {
  for (const [name, rules] of Object.entries(CATEGORIES)) {
    if (rules.some(([k, re]) => k in tags && new RegExp(re).test(tags[k]))) return name;
  }
  return null;
}

export async function fetchAmenities(loc) {
  const body = new URLSearchParams({ data: overpassQuery(loc.lat, loc.lon, AMENITY_RADIUS_M) }).toString();
  let data, lastErr;
  for (const url of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]) {
    try {
      data = await getJSON(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 70000 });
      break;
    } catch (e) { lastErr = e; }
  }
  if (!data) throw new SourceError(`OpenStreetMap (Overpass) unavailable: ${lastErr?.message}`);
  const grouped = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, []]));
  for (const el of data.elements || []) {
    const tags = el.tags || {};
    const cat = categoryOf(tags);
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (!cat || lat == null) continue;
    grouped[cat].push({
      name: tags.name || tags.brand || "", lat, lon,
      miles: round(haversineMiles(loc.lat, loc.lon, lat, lon), 2),
      cuisine: (tags.cuisine || "").replaceAll(";", ", ").replaceAll("_", " "),
    });
  }
  const categories = {};
  for (const [name, items] of Object.entries(grouped)) {
    items.sort((a, b) => a.miles - b.miles);
    categories[name] = { count: items.length, nearestMiles: items[0]?.miles ?? null, nearest: items.filter((i) => i.name).slice(0, 8) };
  }
  return { radiusMiles: round(AMENITY_RADIUS_M / 1609.34, 1), categories };
}

// ---------------------------------------------------------------- crime (FBI CDE)

const CDE = "https://api.usa.gov/crime/fbi/cde";
const OFFENSES = { violent: ["V", "violent-crime"], property: ["P", "property-crime"] };

function classifySeries(series, agencyName) {
  const name = series.toLowerCase();
  if (name.includes("clearance")) return null;
  if (name.startsWith("united states")) return "us";
  if (name.startsWith(agencyName.toLowerCase().slice(0, 20))) return "agency";
  if (name.startsWith("pennsylvania")) return "pa";
  return null;
}

export function annualRate(monthly, year) {
  const vals = Object.entries(monthly).filter(([k, v]) => k.endsWith(String(year)) && isNum(v)).map(([, v]) => v);
  if (!vals.length) return [null, 0];
  return [round((vals.reduce((a, b) => a + b, 0) / vals.length) * 12, 1), vals.length];
}

async function offenseRates(ori, agencyName, codes, year, apiKey) {
  for (const code of codes) {
    let data;
    try {
      data = await getJSON(`${CDE}/summarized/agency/${ori}/${code}`, { params: { API_KEY: apiKey, from: `01-${year}`, to: `12-${year}` } });
    } catch { continue; }
    const out = {};
    for (const [series, monthly] of Object.entries(data?.offenses?.rates || {})) {
      const kind = classifySeries(series, agencyName);
      if (!kind || typeof monthly !== "object") continue;
      const [rate, months] = annualRate(monthly, year);
      if (rate != null) { out[kind] = rate; if (kind === "agency") out.months = months; }
    }
    if ("agency" in out) return out;
  }
  return null;
}

export async function fetchCrime(loc, keys) {
  const apiKey = keys.datagov || "DEMO_KEY";
  const data = await getJSON(`${CDE}/agency/byStateAbbr/PA`, { params: { API_KEY: apiKey } });
  const groups = Array.isArray(data) ? [data] : Object.values(data || {});
  const agencies = groups.flatMap((g) => (Array.isArray(g) ? g : []))
    .filter((a) => a.ori && a.latitude != null && a.longitude != null)
    .map((a) => ({ ori: a.ori, name: a.agency_name || a.ori, miles: round(haversineMiles(loc.lat, loc.lon, +a.latitude, +a.longitude), 1) }))
    .filter((a) => a.miles <= 15)
    // local departments before State Police barracks, then nearest first
    .sort((a, b) => (/state police/i.test(a.name) - /state police/i.test(b.name)) || a.miles - b.miles);
  if (!agencies.length) throw new SourceError("No reporting police agencies found nearby.");
  const thisYear = new Date().getFullYear();
  const results = [], cmp = {};
  let dataYear = null;
  for (const agency of agencies) {
    if (results.length >= 3) break;
    for (const year of dataYear ? [dataYear] : [thisYear - 1, thisYear - 2, thisYear - 3]) {
      const entry = {};
      for (const [label, codes] of Object.entries(OFFENSES)) {
        const r = await offenseRates(agency.ori, agency.name, codes, year, apiKey);
        if (!r) continue;
        entry[label] = r.agency; entry.months = r.months;
        cmp[`${label}Pa`] ??= r.pa; cmp[`${label}Us`] ??= r.us;
      }
      if (Object.keys(entry).length) { dataYear = year; results.push({ ...agency, ...entry }); break; }
    }
  }
  if (!results.length) throw new SourceError("FBI Crime Data Explorer returned no data for nearby agencies (DEMO_KEY may be rate-limited; add a free api.data.gov key).");
  return {
    year: dataYear, agencies: results,
    pa: { violent: cmp.violentPa ?? null, property: cmp.propertyPa ?? null },
    us: { violent: cmp.violentUs ?? null, property: cmp.propertyUs ?? null },
  };
}

// ---------------------------------------------------------------- flood + PA notes

const ZONE_MEANING = {
  A: "High risk (1% annual chance) - flood insurance typically required with a mortgage",
  AE: "High risk (1% annual chance) - flood insurance typically required with a mortgage",
  AH: "High risk, shallow ponding - flood insurance typically required",
  AO: "High risk, sheet flow - flood insurance typically required",
  X: "Moderate to minimal risk",
  D: "Undetermined risk",
};

export async function fetchFlood(loc) {
  const data = await getJSON("https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query", {
    params: {
      geometry: `${loc.lon},${loc.lat}`, geometryType: "esriGeometryPoint", inSR: 4326,
      spatialRel: "esriSpatialRelIntersects", outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF", returnGeometry: "false", f: "json",
    },
  });
  if (data.error) throw new SourceError(`FEMA error: ${data.error.message || "unknown"}`);
  const a = data.features?.[0]?.attributes;
  if (!a) return { zone: null, meaning: "Not mapped by FEMA at the ZIP center" };
  return { zone: a.FLD_ZONE, subtype: a.ZONE_SUBTY, meaning: ZONE_MEANING[a.FLD_ZONE] || "" };
}

export function paNotes(loc) {
  const philly = /philadelphia/i.test(loc.county);
  return [
    ["Realty transfer tax", philly
      ? "Philadelphia's combined realty transfer tax is over 4% (1% state plus the city's ~3.5%), customarily split 50/50 between buyer and seller."
      : "PA realty transfer tax is 1% state + usually 1% local (some municipalities charge more), customarily split 50/50 between buyer and seller."],
    ["Radon", "Pennsylvania has some of the highest radon levels in the US; PA DEP estimates about 40% of homes exceed the EPA action level. Get a radon test during inspection."],
    ["Mine subsidence", "Much of western and northeastern PA sits over old coal mines. Standard homeowners policies exclude subsidence; the state's Mine Subsidence Insurance (MSI) program is inexpensive - check whether the area is eligible."],
    ["Sinkholes", "Limestone (karst) areas such as the Lehigh Valley, Lancaster, Cumberland and Centre counties are prone to sinkholes - ask about history and check the PA geological survey maps."],
    ["Property & school taxes", "PA property tax is mostly school district tax and varies widely between neighboring districts. Check the county assessment and the school district millage for the exact parcel; the estimate on this page uses Census medians."],
    ["Private wells & septic", "Many PA homes outside cities use wells and on-lot septic; PA has no statewide private well standards, so order water and septic inspections."],
    ["Flood maps", "The flood zone shown is for the ZIP's center only. Look up the exact address on FEMA's map.", `https://msc.fema.gov/portal/search?AddressQuery=${loc.zip}`],
  ];
}

// ---------------------------------------------------------------- costs

export function monthlyPayment(principal, ratePct, years) {
  const n = years * 12, r = ratePct / 100 / 12;
  return r === 0 ? principal / n : (principal * r) / (1 - (1 + r) ** -n);
}

export function estimateCosts(price, taxRatePct, annualTaxes, ratePct, downPct, years = 30) {
  if (!price) return null;
  const down = (price * downPct) / 100, loan = price - down;
  const pi = monthlyPayment(loan, ratePct, years);
  const taxes = taxRatePct ? (price * taxRatePct) / 100 / 12 : annualTaxes ? annualTaxes / 12 : 0;
  const insurance = (price * HOME_INSURANCE_RATE) / 12;
  const pmi = downPct < 20 ? (loan * PMI_RATE) / 12 : 0;
  const total = pi + taxes + insurance + pmi;
  return {
    price: Math.round(price), down: Math.round(down), pi: Math.round(pi), taxes: Math.round(taxes),
    insurance: Math.round(insurance), pmi: Math.round(pmi), total: Math.round(total),
    incomeNeeded: Math.round((total * 12) / 0.28 / 1000) * 1000,
  };
}

// ---------------------------------------------------------------- rendering

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (v) => (isNum(v) ? `$${Math.round(v).toLocaleString("en-US")}` : "n/a");
const num = (v, suffix = "") => {
  if (!isNum(v)) return "n/a";
  const s = Number.isInteger(v) || Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return s + suffix;
};
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const stat = (v, k, cls = "") => `<div class="stat"><div class="v ${cls}">${v}</div><div class="k">${k}</div></div>`;
const unavailable = (err) => `<p class="unavail">${esc(err.message || err)}</p>`;
const trend = (v) => (v == null ? "" : v >= 0 ? "up" : "down");

function card(id, title, wide = false) {
  return `<section class="card${wide ? " wide" : ""}" id="${id}"><h2>${title}</h2><div class="body"><p class="loading">Loading…</p></div></section>`;
}
function fill(id, html) {
  const el = document.querySelector(`#${id} .body`);
  if (el) el.innerHTML = html;
}

function sparkline(history) {
  const vals = history.map(([, v]) => v);
  if (vals.length < 2) return "";
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1, W = 560, H = 120;
  const pts = vals.map((v, i) => `${((i * W) / (vals.length - 1)).toFixed(1)},${(H - ((v - lo) / span) * (H - 10) - 5).toFixed(1)}`).join(" ");
  return `<h3>Zillow home value index, ${esc(history[0][0])} to ${esc(history.at(-1)[0])}</h3>
    <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Home value trend between ${money(lo)} and ${money(hi)}"><polyline points="${pts}"/></svg>
    <div class="muted small">Range ${money(lo)} – ${money(hi)}</div>`;
}

function renderValues(r) {
  const parts = [];
  if (r.zhvi.ok) {
    const z = r.zhvi.value;
    parts.push(stat(money(z.value), `Zillow typical value (${esc(z.asOf)})`),
      stat(num(z.change1y, "%"), "1-year change", trend(z.change1y)),
      stat(num(z.change5y, "%"), "5-year change", trend(z.change5y)));
  }
  if (r.listings.ok) {
    const s = r.listings.value.inZip;
    parts.push(stat(money(s.median), `Median asking price in ZIP (${s.count} active)`),
      stat(money(s.ppsf), "Median asking $/sqft"), stat(num(s.dom), "Median days on market"));
  }
  if (r.acs.ok) {
    const { zip: z, pa } = r.acs.value;
    parts.push(stat(money(z.medianHomeValue), `Census median value (PA ${money(pa.medianHomeValue)})`),
      stat(money(z.medianRent), "Median rent"),
      stat(money(z.medianTaxes), `Median property tax / yr (~${num(z.taxRatePct, "%")})`),
      stat(num(z.priceToIncome, "x"), "Value-to-income ratio"));
  }
  let html = parts.length ? `<div class="stats">${parts.join("")}</div>` : "";
  if (r.zhvi.ok) html += sparkline(r.zhvi.value.history);
  if (!r.zhvi.ok) html += `<p class="unavail small">Zillow: ${esc(r.zhvi.error.message)}</p>`;
  if (!r.acs.ok) html += `<p class="unavail small">Census: ${esc(r.acs.error.message)}</p>`;
  return html;
}

function renderCosts(r, ratePct, downPct) {
  const z = r.acs.ok ? r.acs.value.zip : {};
  let basis, price;
  if (r.zhvi.ok) [basis, price] = ["Zillow typical home value", r.zhvi.value.value];
  else if (r.listings.ok && r.listings.value.inZip.median) [basis, price] = ["median asking price in this ZIP", r.listings.value.inZip.median];
  else [basis, price] = ["Census median home value", z.medianHomeValue];
  const c = estimateCosts(price, z.taxRatePct, z.medianTaxes, ratePct, downPct);
  if (!c) return unavailable("Not enough price data for an estimate.");
  const share = z.medianIncome ? round((100 * c.total * 12) / z.medianIncome, 1) : null;
  return `<p class="muted small">For a ${money(c.price)} home (${basis}), ${num(downPct)}% down, ${num(ratePct)}% for 30 years. Change the rate or down payment above to update.</p>
    <table>
      <tr><td>Principal &amp; interest</td><td class="r">${money(c.pi)}</td></tr>
      <tr><td>Property tax (est.)</td><td class="r">${money(c.taxes)}</td></tr>
      <tr><td>Homeowners insurance (est.)</td><td class="r">${money(c.insurance)}</td></tr>
      ${c.pmi ? `<tr><td>PMI (est.)</td><td class="r">${money(c.pmi)}</td></tr>` : ""}
      <tr><th>Total</th><th class="r">${money(c.total)}</th></tr>
    </table>
    <p class="small">Down payment ${money(c.down)}. Income needed at the 28% guideline: <strong>${money(c.incomeNeeded)}</strong>${z.medianIncome ? `; local median household income is ${money(z.medianIncome)} (${num(share, "%")} of it)` : ""}.</p>`;
}

function renderCrime(cr) {
  const above = (v, pa) => (v != null && pa != null && v > pa ? "down" : "");
  return `<p class="muted small">Offenses per 100,000 residents, ${cr.year} (FBI). Lower is safer.</p>
    <table><tr><th>Agency</th><th class="r">Violent</th><th class="r">Property</th></tr>
    ${cr.agencies.map((a) => `<tr><td>${esc(a.name)} <span class="muted small">${a.miles} mi${a.months && a.months < 12 ? `, ${a.months} mo reported` : ""}</span></td>
      <td class="r ${above(a.violent, cr.pa.violent)}">${num(a.violent)}</td><td class="r ${above(a.property, cr.pa.property)}">${num(a.property)}</td></tr>`).join("")}
    <tr><td><em>Pennsylvania</em></td><td class="r">${num(cr.pa.violent)}</td><td class="r">${num(cr.pa.property)}</td></tr>
    <tr><td><em>United States</em></td><td class="r">${num(cr.us.violent)}</td><td class="r">${num(cr.us.property)}</td></tr></table>
    <p class="muted small">Agency figures cover the whole jurisdiction, not just this ZIP. Red = above the PA rate.</p>`;
}

function renderListings(l, maxMinutes, loc) {
  const s = l.stats;
  return `<div class="stats">${stat(s.count, "Active listings")}${stat(money(s.median), "Median price")}
      ${stat(`${money(s.min)} – ${money(s.max)}`, "Price range")}${stat(money(s.ppsf), "Median $/sqft")}</div>
    ${l.method !== "osrm" ? `<p class="unavail small">Routing service unavailable, so drive times are estimated from distance.</p>` : ""}
    ${l.homes.length ? `<div class="scroll tablewrap"><table>
      <tr><th>Address</th><th class="r">Price</th><th class="r">Beds</th><th class="r">Baths</th><th class="r">Sqft</th><th class="r">Built</th><th>Type</th><th class="r">Drive</th><th class="r">DOM</th></tr>
      ${l.homes.map((h) => `<tr><td>${esc(h.address)}</td><td class="r">${money(h.price)}</td><td class="r">${num(h.beds)}</td><td class="r">${num(h.baths)}</td>
        <td class="r">${num(h.sqft)}</td><td class="r">${esc(h.built || "")}</td><td>${esc(h.type || "")}</td><td class="r">${num(h.drive)} min</td><td class="r">${num(h.dom)}</td></tr>`).join("")}
    </table></div>` : `<p>No active listings within ${maxMinutes} minutes.</p>`}`;
}

function renderSchools(sc) {
  if (!sc.schools.length) return `<p>No schools found within ${SCHOOL_RADIUS_MILES} miles.</p>`;
  const badge = (r) => `<span class="badge ${r == null ? "b-na" : r >= 7 ? "b-hi" : r >= 4 ? "b-mid" : "b-lo"}">${r ?? "n/a"}</span>`;
  return `<p class="muted small">Score 1-10 = average % of students proficient in reading &amp; math on PA state tests ÷ 10 (not a GreatSchools rating). Source: NCES Common Core of Data ${sc.year} + EDFacts. Confirm the assigned school for a specific address with the district.</p>
    <div class="tablewrap"><table><tr><th class="r">Score</th><th>School</th><th>Level</th><th>District</th><th class="r">Students</th><th class="r">Students / teacher</th><th class="r">Distance</th></tr>
    ${sc.schools.map((x) => `<tr><td class="r">${badge(x.rating)}</td>
      <td>${esc(x.name)}${x.charter ? ' <span class="muted small">(charter)</span>' : ""}
        ${x.prof ? `<div class="muted small">Reading ${num(x.prof.read, "%")} · Math ${num(x.prof.math, "%")} proficient (${x.prof.year})</div>` : ""}</td>
      <td>${esc(x.level)} <span class="muted small">${esc(x.grades)}</span></td><td>${esc(x.district)}</td>
      <td class="r">${num(x.enrollment)}</td><td class="r">${num(x.ratio)}</td><td class="r">${x.miles} mi</td></tr>`).join("")}
    </table></div>`;
}

function renderRestaurants(a) {
  const list = a.categories.Restaurants.nearest;
  if (!list.length) return "<p>No restaurants found nearby in OpenStreetMap.</p>";
  return `<ul class="notes">${list.map((x) => `<li>${esc(x.name)} ${x.cuisine ? `<span class="muted small">${esc(x.cuisine)}</span>` : ""} · ${x.miles} mi</li>`).join("")}</ul>`;
}

function renderAmenities(a) {
  return `<p class="muted small">Counts within ${a.radiusMiles} miles (OpenStreetMap).</p>
    <table><tr><th>Type</th><th class="r">Count</th><th>Nearest</th></tr>
    ${Object.entries(a.categories).map(([name, info]) => `<tr><td>${esc(name)}</td><td class="r">${info.count}</td><td>${
      info.nearest.length ? `${esc(info.nearest[0].name)} <span class="muted small">${info.nearest[0].miles} mi</span>`
        : info.nearestMiles != null ? `<span class="muted small">${info.nearestMiles} mi</span>` : '<span class="muted small">none nearby</span>'}</td></tr>`).join("")}
    </table>`;
}

function renderProfile(acs) {
  const { zip: z, pa } = acs;
  const row = (label, a, b) => `<tr><td>${label}</td><td class="r">${a}</td><td class="r">${b}</td></tr>`;
  const yr = (v) => (v ? String(Math.round(v)) : "n/a");
  return `<p class="muted small">Census ACS 5-year ${acs.year}.</p><table><tr><th></th><th class="r">This ZIP</th><th class="r">PA</th></tr>
    ${row("Population", num(z.population), "")}
    ${row("Median household income", money(z.medianIncome), money(pa.medianIncome))}
    ${row("Median age", num(z.medianAge), num(pa.medianAge))}
    ${row("Owner-occupied homes", num(z.ownerPct, "%"), num(pa.ownerPct, "%"))}
    ${row("Vacant housing", num(z.vacancyPct, "%"), num(pa.vacancyPct, "%"))}
    ${row("Below poverty line", num(z.povertyPct, "%"), num(pa.povertyPct, "%"))}
    ${row("Bachelor's degree or higher", num(z.degreePct, "%"), num(pa.degreePct, "%"))}
    ${row("Median year homes built", yr(z.medianYearBuilt), yr(pa.medianYearBuilt))}
    ${row("Mean commute", num(z.commuteMinutes, " min"), num(pa.commuteMinutes, " min"))}</table>`;
}

function renderRisks(flood, loc) {
  const top = flood.ok
    ? `<p><strong>FEMA flood zone at ZIP center: ${esc(flood.value.zone || "not mapped")}</strong>${flood.value.subtype ? ` <span class="muted small">${esc(flood.value.subtype)}</span>` : ""}<br><span class="small">${esc(flood.value.meaning)}</span></p>`
    : `<p class="unavail small">Flood zone: ${esc(flood.error.message)}</p>`;
  return `${top}<ul class="notes small">${paNotes(loc).map(([t, text, href]) => `<li><strong>${esc(t)}.</strong> ${esc(text)}${href ? ` ${link(href, "Look up")}` : ""}</li>`).join("")}</ul>`;
}

// ---------------------------------------------------------------- map

let map;
function drawMap(loc, r) {
  if (!window.L) { fill("map-card", '<p class="unavail">Map library failed to load.</p>'); return; }
  fill("map-card", `<div class="legend"><span><i class="dot" style="background:#2457c5"></i>For sale</span><span><i class="dot" style="background:#1d7a46"></i>Schools</span><span><i class="dot" style="background:#7c3aed"></i>Amenities</span><span><i class="dot" style="background:#111"></i>ZIP center</span></div><div id="map"></div>`);
  map?.remove();
  map = L.map("map").setView([loc.lat, loc.lon], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
  const bounds = [[loc.lat, loc.lon]];
  const text = (t) => { const el = document.createElement("div"); el.textContent = t; return el; };
  const add = (lat, lon, color, label) => {
    if (lat == null || lon == null) return;
    L.circleMarker([lat, lon], { radius: 6, color, weight: 1, fillOpacity: 0.75 }).addTo(map).bindPopup(text(label));
    bounds.push([lat, lon]);
  };
  L.circleMarker([loc.lat, loc.lon], { radius: 8, color: "#111", fillOpacity: 0.9 }).addTo(map).bindPopup(text(`ZIP ${loc.zip} center`));
  if (r.listings.ok) r.listings.value.homes.slice(0, 200).forEach((h) => add(h.lat, h.lon, "#2457c5", `${money(h.price)} - ${h.address} (${h.drive} min)`));
  if (r.schools.ok) r.schools.value.schools.forEach((s) => add(s.lat, s.lon, "#1d7a46", `${s.name} (${s.level}) score ${s.rating ?? "n/a"}`));
  if (r.amenities.ok) {
    for (const cat of ["Grocery stores", "Parks & playgrounds", "Hospitals & clinics", "Train & subway stations", "Libraries"]) {
      r.amenities.value.categories[cat].nearest.slice(0, 3).forEach((x) => add(x.lat, x.lon, "#7c3aed", `${cat}: ${x.name}`));
    }
  }
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 14 });
}

// ---------------------------------------------------------------- orchestration

const settle = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
let current = null; // results of the latest search, for live cost updates
let runId = 0;

function readInputs() {
  const val = (id, d) => { const n = parseFloat(document.getElementById(id).value); return Number.isFinite(n) ? n : d; };
  return {
    zip: document.getElementById("zip").value.trim(),
    drive: Math.max(5, Math.min(60, Math.round(val("drive", 20)))),
    rate: Math.max(0, val("rate", 6.5)),
    down: Math.max(0, Math.min(100, val("down", 20))),
  };
}

function setStatus(msg, error = false) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = error ? "error" : "";
}

function refreshCosts() {
  if (!current?.done) return;
  const { rate, down } = readInputs();
  fill("cost-card", renderCosts(current.results, rate, down));
}

async function run() {
  const { zip, drive, rate, down } = readInputs();
  const id = ++runId;
  const report = document.getElementById("report");
  const button = document.getElementById("go");
  report.innerHTML = "";
  current = null;
  setStatus(`Looking up ${zip}…`);
  button.disabled = true;
  const url = new URL(location.href);
  url.searchParams.set("zip", zip);
  history.replaceState(null, "", url);

  let loc;
  try {
    loc = await geocode(zip);
  } catch (err) {
    if (id === runId) { setStatus(err.message, true); button.disabled = false; }
    return;
  }
  if (id !== runId) return;
  const keys = loadKeys();
  const links = { ...searchLinks(loc),
    "Walk Score": `https://www.walkscore.com/score/loc/lat=${loc.lat}/lng=${loc.lon}`,
    GreatSchools: `https://www.greatschools.org/search/search.page?lat=${loc.lat}&lon=${loc.lon}&distance=5`,
    "FEMA flood map": `https://msc.fema.gov/portal/search?AddressQuery=${loc.zip}`,
    "FBI Crime Data Explorer": "https://cde.ucr.cjis.gov/",
    "PA crime stats (UCR)": "https://www.ucr.pa.gov/",
    "Yelp restaurants": `https://www.yelp.com/search?find_desc=Restaurants&find_loc=${loc.zip}&sortby=rating`,
  };
  setStatus("Gathering data – sections fill in as they arrive.");
  report.innerHTML = `<div class="grid">
    <section class="card wide"><h2>${esc(loc.place)}, PA ${esc(loc.zip)}</h2><div class="muted small">${esc(loc.county || "County unknown")}</div></section>
    ${card("values-card", "What homes are going for", true)}
    ${card("cost-card", "Estimated monthly cost")}
    ${card("crime-card", "Crime")}
    ${card("map-card", "Map", true)}
    ${card("listings-card", `Homes for sale within ${drive} minutes' drive`, true)}
    ${card("schools-card", "Schools nearby", true)}
    ${card("restaurants-card", "Restaurants nearby")}
    ${card("amenities-card", "Amenities")}
    ${card("profile-card", "Neighborhood profile")}
    ${card("risks-card", "Flood risk &amp; PA buyer checklist")}
    <section class="card wide links"><h2>More research</h2>${Object.entries(links).map(([n, h]) => link(h, n)).join("")}</section>
  </div>`;

  const p = {
    zhvi: settle(fetchZhvi(zip)), acs: settle(fetchAcs(zip, keys)), listings: settle(fetchListings(loc, drive, keys)),
    schools: settle(fetchSchools(loc)), amenities: settle(fetchAmenities(loc)), crime: settle(fetchCrime(loc, keys)),
    flood: settle(fetchFlood(loc)),
  };
  const guard = (fn) => (v) => { if (id === runId) fn(v); };
  const listingLinks = `<div class="links">${Object.entries(searchLinks(loc)).map(([n, h]) => link(h, `Search ${n}`)).join("")}</div>`;
  p.crime.then(guard((r) => fill("crime-card", r.ok ? renderCrime(r.value) : unavailable(r.error))));
  p.listings.then(guard((r) => fill("listings-card", (r.ok ? renderListings(r.value, drive, loc) : unavailable(r.error)) + listingLinks)));
  p.schools.then(guard((r) => fill("schools-card", r.ok ? renderSchools(r.value) : unavailable(r.error))));
  p.amenities.then(guard((r) => {
    fill("amenities-card", r.ok ? renderAmenities(r.value) : unavailable(r.error));
    fill("restaurants-card", (r.ok ? renderRestaurants(r.value) : unavailable(r.error))
      + `<p class="small muted">Ratings aren't available to a browser-only app. ${link(links["Yelp restaurants"], "See top-rated on Yelp")}</p>`);
  }));
  p.acs.then(guard((r) => fill("profile-card", r.ok ? renderProfile(r.value) : unavailable(r.error))));
  p.flood.then(guard((r) => fill("risks-card", renderRisks(r, loc))));

  const results = Object.fromEntries(await Promise.all(Object.entries(p).map(async ([k, v]) => [k, await v])));
  if (id !== runId) return;
  current = { results, done: true };
  fill("values-card", renderValues(results));
  refreshCosts();
  drawMap(loc, results);
  const failed = Object.values(results).filter((r) => !r.ok).length;
  setStatus(failed ? `Done. ${failed} section${failed > 1 ? "s" : ""} couldn't load – see notes in each.` : "Done.");
  button.disabled = false;
}

// ---------------------------------------------------------------- wiring

function init() {
  const keys = loadKeys();
  const keyInputs = { rentcast: "key-rentcast", datagov: "key-datagov", census: "key-census" };
  for (const [k, id] of Object.entries(keyInputs)) document.getElementById(id).value = keys[k] || "";
  const settingsBtn = document.getElementById("settings-btn");
  settingsBtn.addEventListener("click", () => {
    const panel = document.getElementById("settings");
    panel.hidden = !panel.hidden;
    settingsBtn.setAttribute("aria-expanded", String(!panel.hidden));
  });
  document.getElementById("save-keys").addEventListener("click", () => {
    const next = Object.fromEntries(Object.entries(keyInputs).map(([k, id]) => [k, document.getElementById(id).value.trim()]));
    document.getElementById("keys-saved").textContent = saveKeys(next) ? "Saved. Run a search to use them." : "Couldn't save (browser storage blocked).";
  });
  document.getElementById("search").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  for (const id of ["rate", "down"]) document.getElementById(id).addEventListener("input", refreshCosts);
  const zip = new URLSearchParams(location.search).get("zip");
  if (zip) { document.getElementById("zip").value = zip; run(); }
}

if (typeof document !== "undefined") init();
