// "My homes": a saved list of listings (shared from Zillow / Redfin / Realtor.com or pasted),
// plus a route planner that orders the selected homes and opens the trip in Google Maps.
// Everything is stored in this browser (localStorage); nothing is sent anywhere except
// geocoding (OpenStreetMap Nominatim) and drive-time (OSRM) lookups for route planning.

const STORE_KEY = "pahs-homes";
const MAPS_STOPS_PER_LINK = 10; // origin + 8 waypoints + destination per Google Maps link
const EXACT_LIMIT = 8; // brute-force the best order up to this many stops to arrange

// ---------------------------------------------------------------- parsing shared listings

const STATE_ZIP = /^(.*?)[\s-]+([A-Za-z]{2})[\s-]+(\d{5})$/;
const ADDRESS_IN_TEXT = /\b(\d+[A-Za-z]?(?:-\d+)?\s+[^,|\n]{2,60}?,\s*[^,|\n]{2,40}?,\s*[A-Z]{2}\s+\d{5})\b/;
const SUFFIXES = new Set(("st street ave avenue rd road dr drive ln lane ct court blvd boulevard way pl place cir circle "
  + "ter terrace pike hwy highway pkwy parkway trl trail sq square aly alley row loop run xing crossing path walk "
  + "ext cv cove grn green hl hill holw hollow mnr manor pt point rdg ridge vw view").split(" "));
const UNIT_WORDS = new Set(["apt", "unit", "ste", "suite", "#", "fl", "floor", "bldg"]);

const titleCase = (s) => s.replace(/\b([a-z])([a-z]*)/g, (_, a, b) => a.toUpperCase() + b);

/** "123 Main St Bryn Mawr" -> ["123 Main St", "Bryn Mawr"] using the street suffix as the split. */
export function splitStreetCity(words) {
  for (let i = 1; i < words.length - 1; i++) {
    if (!SUFFIXES.has(words[i].toLowerCase())) continue;
    let end = i + 1;
    // directional after the suffix ("Main St N") or a unit ("Apt 4B")
    if (end < words.length - 1 && /^(n|s|e|w|ne|nw|se|sw)$/i.test(words[end])) end++;
    if (end < words.length - 2 && UNIT_WORDS.has(words[end].toLowerCase())) end += 2;
    return [words.slice(0, end).join(" "), words.slice(end).join(" ")];
  }
  return [words.join(" "), ""];
}

function fromSlug(slug, { lower = false } = {}) {
  let text = decodeURIComponent(slug).replace(/[-_]+/g, " ").trim();
  if (lower || text === text.toLowerCase()) text = titleCase(text);
  const m = text.match(STATE_ZIP);
  const body = m ? m[1] : text.replace(/\s+[A-Za-z]{2}$/, "");
  const state = m ? m[2].toUpperCase() : (text.match(/\s([A-Za-z]{2})$/)?.[1] || "").toUpperCase();
  const zip = m ? m[3] : "";
  const [street, city] = splitStreetCity(body.split(/\s+/));
  return [street, city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

/** Best-effort address from a listing URL on the major US listing sites. */
export function addressFromUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host.endsWith("zillow.com") && parts[0] === "homedetails" && parts[1]) {
    return { address: fromSlug(parts[1]), source: "Zillow" };
  }
  if (host.endsWith("redfin.com") && parts.length >= 3 && /^[A-Z]{2}$/.test(parts[0])) {
    const m = parts[2].match(/^(.*?)-(\d{5})$/);
    const street = (m ? m[1] : parts[2]).replace(/-/g, " ");
    const city = parts[1].replace(/-/g, " ");
    return { address: `${street}, ${city}, ${parts[0]}${m ? ` ${m[2]}` : ""}`, source: "Redfin" };
  }
  if (host.endsWith("realtor.com") && parts[0] === "realestateandhomes-detail" && parts[1]) {
    const bits = parts[1].split("_");
    if (bits.length >= 4) {
      const [street, city, state, zip] = bits.map((b) => b.replace(/-/g, " "));
      return { address: `${street}, ${city}, ${state} ${zip}`, source: "Realtor.com" };
    }
  }
  if (host.endsWith("trulia.com") && parts[0] === "home" && parts[1]) {
    return { address: fromSlug(parts[1].replace(/-\d+$/, ""), { lower: true }), source: "Trulia" };
  }
  if (host.endsWith("homes.com") && parts[0] === "property" && parts[1]) {
    return { address: fromSlug(parts[1], { lower: true }), source: "Homes.com" };
  }
  return null;
}

const SOURCES = [["zillow.com", "Zillow"], ["redfin.com", "Redfin"], ["realtor.com", "Realtor.com"], ["trulia.com", "Trulia"], ["homes.com", "Homes.com"]];
const sourceOf = (url) => SOURCES.find(([d]) => { try { return new URL(url).hostname.endsWith(d); } catch { return false; } })?.[1] || "";

/**
 * Turn whatever a share sheet / bookmarklet / paste gives us into { address, url, source }.
 * Prefers an address written out in the shared text or page title, then the listing URL.
 */
export function parseShared({ url = "", title = "", text = "" } = {}) {
  const all = [text, title, url].filter(Boolean).join("\n");
  const link = (url && /^https?:/i.test(url) ? url : all.match(/https?:\/\/\S+/)?.[0]) || "";
  const cleanLink = link.replace(/[)\].,;]+$/, "");
  for (const candidate of [text, title]) {
    const m = candidate && candidate.match(ADDRESS_IN_TEXT);
    if (m) return { address: m[1].replace(/\s+/g, " ").trim(), url: cleanLink, source: sourceOf(cleanLink) };
  }
  if (cleanLink) {
    const fromLink = addressFromUrl(cleanLink);
    if (fromLink) return { ...fromLink, url: cleanLink };
  }
  // A typed / pasted plain address
  const plain = all.replace(/https?:\/\/\S+/g, "").trim();
  if (/\d/.test(plain) && /[a-z]{2}/i.test(plain) && plain.length <= 150 && !cleanLink) {
    return { address: plain.replace(/\s+/g, " "), url: "", source: "" };
  }
  return null;
}

export const normalizeAddress = (a) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const zipOf = (a) => a.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1] || "";

// ---------------------------------------------------------------- storage

let memoryFallback = [];
export function loadHomes() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY));
    return Array.isArray(v) ? v : [];
  } catch { return memoryFallback; }
}
function saveHomes(list) {
  memoryFallback = list;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

/** Add a parsed listing; returns { added, item, duplicate }. */
export function addHome(parsed) {
  const list = loadHomes();
  const key = normalizeAddress(parsed.address);
  const existing = list.find((h) => normalizeAddress(h.address) === key);
  if (existing) {
    if (parsed.url && !existing.url) { existing.url = parsed.url; existing.source = parsed.source; saveHomes(list); }
    return { added: false, duplicate: true, item: existing };
  }
  const item = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    address: parsed.address, url: parsed.url || "", source: parsed.source || "",
    added: new Date().toISOString().slice(0, 10), selected: true,
  };
  list.push(item);
  saveHomes(list);
  return { added: true, duplicate: false, item };
}

export function updateHomes(fn) {
  const list = fn(loadHomes());
  saveHomes(list);
  return list;
}

// Share a list between devices through a link: #homes=<base64url JSON>
export function encodeList(list) {
  const json = JSON.stringify(list.map((h) => [h.address, h.url || ""]));
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeList(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const rows = JSON.parse(new TextDecoder().decode(bytes));
  return rows.filter((r) => Array.isArray(r) && typeof r[0] === "string")
    .map(([address, url]) => ({ address, url: typeof url === "string" ? url : "", source: sourceOf(url || "") }));
}

// ---------------------------------------------------------------- route planning

export function haversineMiles(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

/** Estimated driving minutes matrix from straight-line distance (fallback when OSRM is down). */
export function estimateMatrix(points) {
  return points.map((a) => points.map((b) => (haversineMiles(a, b) * 1.3 / 35) * 60));
}

export function routeCost(matrix, order, roundTrip) {
  let c = 0;
  for (let i = 1; i < order.length; i++) c += matrix[order[i - 1]][order[i]];
  if (roundTrip && order.length > 1) c += matrix[order.at(-1)][order[0]];
  return c;
}

function* permutations(arr) {
  // Heap's algorithm
  const a = [...arr], c = new Array(a.length).fill(0);
  yield [...a];
  let i = 0;
  while (i < a.length) {
    if (c[i] < i) {
      const j = i % 2 ? c[i] : 0;
      [a[j], a[i]] = [a[i], a[j]];
      yield [...a];
      c[i]++; i = 0;
    } else { c[i] = 0; i++; }
  }
}

function twoOpt(matrix, order, roundTrip, fixedStart) {
  let best = order, bestCost = routeCost(matrix, order, roundTrip), improved = true;
  const first = fixedStart ? 1 : 0;
  while (improved) {
    improved = false;
    for (let i = first; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)];
        const c = routeCost(matrix, cand, roundTrip);
        if (c < bestCost - 1e-9) { best = cand; bestCost = c; improved = true; }
      }
    }
  }
  return best;
}

/**
 * Best visiting order over matrix indices 0..n-1.
 * start: index to begin at (or null to let the planner pick), roundTrip: return to the start.
 */
export function solveRoute(matrix, { start = null, roundTrip = false } = {}) {
  const n = matrix.length;
  if (n <= 2) return start === 1 ? [1, 0].slice(0, n) : [...Array(n).keys()];
  const fixed = start ?? (roundTrip ? 0 : null);
  if (fixed !== null) {
    const rest = [...Array(n).keys()].filter((i) => i !== fixed);
    if (rest.length <= EXACT_LIMIT) {
      let best = null, bestCost = Infinity;
      for (const p of permutations(rest)) {
        const c = routeCost(matrix, [fixed, ...p], roundTrip);
        if (c < bestCost) { bestCost = c; best = [fixed, ...p]; }
      }
      return best;
    }
    return twoOpt(matrix, nearestNeighbour(matrix, fixed), roundTrip, true);
  }
  if (n <= EXACT_LIMIT) {
    let best = null, bestCost = Infinity;
    for (const p of permutations([...Array(n).keys()])) {
      const c = routeCost(matrix, p, false);
      if (c < bestCost) { bestCost = c; best = p; }
    }
    return best;
  }
  let best = null, bestCost = Infinity;
  for (let s = 0; s < n; s++) {
    const cand = twoOpt(matrix, nearestNeighbour(matrix, s), false, false);
    const c = routeCost(matrix, cand, false);
    if (c < bestCost) { bestCost = c; best = cand; }
  }
  return best;
}

function nearestNeighbour(matrix, start) {
  const n = matrix.length, seen = new Set([start]), order = [start];
  while (order.length < n) {
    const last = order.at(-1);
    let next = -1;
    for (let j = 0; j < n; j++) if (!seen.has(j) && (next < 0 || matrix[last][j] < matrix[last][next])) next = j;
    seen.add(next); order.push(next);
  }
  return order;
}

/** Google Maps directions links for an ordered list of stops (strings), split into legs of 10. */
export function googleMapsLinks(stops, { useCurrentLocation = false } = {}) {
  const links = [];
  let i = 0;
  // When starting from "my location", leave origin out of the first link so Google Maps uses the
  // phone's live location.
  // stops[0] is then the user's position, which Google Maps supplies itself.
  if (useCurrentLocation) {
    const chunk = stops.slice(1, MAPS_STOPS_PER_LINK);
    links.push(mapsDirUrl(null, chunk));
    i = chunk.length; // index in `stops` of this link's destination
  }
  while (i < stops.length - 1) {
    const chunk = stops.slice(i, i + MAPS_STOPS_PER_LINK);
    links.push(mapsDirUrl(chunk[0], chunk.slice(1)));
    i += chunk.length - 1;
  }
  return links;
}

function mapsDirUrl(origin, rest) {
  const params = new URLSearchParams({ api: "1", travelmode: "driving", destination: rest.at(-1) });
  if (origin) params.set("origin", origin);
  if (rest.length > 1) params.set("waypoints", rest.slice(0, -1).join("|"));
  return `https://www.google.com/maps/dir/?${params}`;
}

// ---------------------------------------------------------------- network helpers (browser only)

let lastNominatim = 0;
async function geocode(address) {
  // Nominatim usage policy: max 1 request/second.
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const params = new URLSearchParams({ format: "json", limit: "1", countrycodes: "us", q: address });
  const resp = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`geocoder HTTP ${resp.status}`);
  const hit = (await resp.json())[0];
  return hit ? { lat: +hit.lat, lon: +hit.lon } : null;
}

async function geocodeHome(home) {
  if (home.lat != null) return home;
  let pt = await geocode(home.address);
  if (!pt) pt = await geocode(home.address.replace(/\b(apt|unit|ste|suite|#)\s*\S+,?/i, "")); // retry without unit
  if (pt) updateHomes((list) => list.map((h) => (h.id === home.id ? { ...h, ...pt } : h)));
  return pt ? { ...home, ...pt } : home;
}

async function driveMatrix(points) {
  try {
    const coords = points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    const resp = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`);
    const data = await resp.json();
    if (data.code !== "Ok") throw new Error(data.code);
    if (data.durations?.length !== points.length) throw new Error("unexpected routing reply");
    return { matrix: data.durations.map((row) => row.map((d) => (d == null ? 1e6 : d / 60))), method: "osrm" };
  } catch {
    return { matrix: estimateMatrix(points), method: "estimate" };
  }
}

function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Location isn't available in this browser."));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error("Location permission was denied.")),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
    );
  });
}

// ---------------------------------------------------------------- UI

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel) => document.querySelector(sel);

function flash(msg, error = false) {
  const el = $("#homes-msg");
  if (!el) return;
  el.textContent = msg;
  el.className = error ? "error" : "ok";
}

function renderList() {
  const list = loadHomes();
  const count = $("#homes-count");
  if (count) count.textContent = list.length ? ` (${list.length})` : "";
  const box = $("#homes-list");
  if (!list.length) {
    box.innerHTML = `<p class="muted">No homes saved yet. Share a listing to this site, or paste a link or address above.</p>`;
    $("#route-card").hidden = true;
    return;
  }
  $("#route-card").hidden = false;
  box.innerHTML = `<div class="homes-actions small">
      <button type="button" class="secondary" data-act="all">Select all</button>
      <button type="button" class="secondary" data-act="none">Select none</button>
      <button type="button" class="secondary" data-act="remove-selected">Remove selected</button>
      <button type="button" class="secondary" data-act="share">Copy list link</button>
    </div>
    <ul class="homes">${list.map((h) => `<li>
      <label class="home-row"><input type="checkbox" data-id="${esc(h.id)}" ${h.selected ? "checked" : ""}>
        <span><strong>${esc(h.address)}</strong>
        <span class="muted small">${h.source ? `${esc(h.source)} · ` : ""}added ${esc(h.added)}${h.lat == null ? "" : " · located"}</span></span></label>
      <span class="home-links small">
        ${h.url ? `<a href="${esc(h.url)}" target="_blank" rel="noopener">Listing</a>` : ""}
        ${zipOf(h.address) ? `<a href="?zip=${zipOf(h.address)}">Scout ${zipOf(h.address)}</a>` : ""}
        <a href="${esc(`https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: h.address })}`)}" target="_blank" rel="noopener">Map</a>
        <button type="button" class="link-btn" data-remove="${esc(h.id)}" aria-label="Remove ${esc(h.address)}">Remove</button>
      </span></li>`).join("")}</ul>`;
  renderStartOptions(list);
}

function renderStartOptions(list) {
  const sel = $("#route-start");
  const prev = sel.value;
  sel.innerHTML = `<option value="me">My current location</option><option value="best">Wherever is most efficient</option>`
    + list.filter((h) => h.selected).map((h) => `<option value="${esc(h.id)}">${esc(h.address)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function planRoute() {
  const selected = loadHomes().filter((h) => h.selected);
  const out = $("#route-result");
  const startMode = $("#route-start").value;
  const roundTrip = $("#route-round").checked;
  if (selected.length < (startMode === "me" ? 1 : 2)) {
    out.innerHTML = `<p class="unavail">Select at least ${startMode === "me" ? "one home" : "two homes"} to plan a route.</p>`;
    return;
  }
  const btn = $("#route-go");
  btn.disabled = true;
  try {
    out.innerHTML = `<p class="loading">Locating ${selected.length} address${selected.length > 1 ? "es" : ""}…</p>`;
    const located = [];
    const missing = [];
    for (const h of selected) {
      try {
        const g = await geocodeHome(h);
        (g.lat != null ? located : missing).push(g);
      } catch { missing.push(h); }
    }
    let points = located.map((h) => ({ lat: h.lat, lon: h.lon, label: h.address, home: h }));
    let start = null;
    if (startMode === "me") {
      out.innerHTML = `<p class="loading">Getting your location…</p>`;
      try {
        const me = await currentPosition();
        points = [{ ...me, label: "Your location", me: true }, ...points];
        start = 0;
      } catch (err) {
        out.innerHTML = `<p class="unavail">${esc(err.message)} Pick a starting home instead.</p>`;
        return;
      }
    } else if (startMode !== "best") {
      start = points.findIndex((p) => p.home?.id === startMode);
      if (start < 0) start = null;
    }
    if (points.length < 2) {
      out.innerHTML = `<p class="unavail">Couldn't locate enough of the selected addresses to plan a route.</p>`;
      return;
    }
    out.innerHTML = `<p class="loading">Working out drive times…</p>`;
    const { matrix, method } = await driveMatrix(points);
    const order = solveRoute(matrix, { start, roundTrip });
    const ordered = order.map((i) => points[i]);
    if (roundTrip) ordered.push(ordered[0]);
    const legs = ordered.slice(1).map((p, i) => matrix[order[i]][order[(i + 1) % order.length]]);
    const total = legs.reduce((a, b) => a + b, 0);
    const stops = ordered.map((p) => (p.me ? `${p.lat},${p.lon}` : p.label));
    const links = googleMapsLinks(stops, { useCurrentLocation: !!ordered[0].me });
    out.innerHTML = `<p><strong>~${Math.round(total)} min of driving</strong> for ${located.length} home${located.length > 1 ? "s" : ""}${roundTrip ? ", returning to the start" : ""}.
        <span class="muted small">${method === "osrm" ? "Drive times from OpenStreetMap routing." : "Drive times estimated from distance."} Google Maps will show live traffic.</span></p>
      <ol class="route">${ordered.map((p, i) => `<li>${esc(p.label)}${i ? ` <span class="muted small">+${Math.round(legs[i - 1])} min</span>` : ""}</li>`).join("")}</ol>
      <p>${links.map((l, i) => `<a class="button" href="${esc(l)}" target="_blank" rel="noopener">${links.length > 1 ? `Open part ${i + 1} of ${links.length} in Google Maps` : "Open route in Google Maps"}</a>`).join(" ")}</p>
      ${links.length > 1 ? `<p class="muted small">Google Maps takes up to 10 stops per route, so the trip is split into parts; each part starts where the last one ended.</p>` : ""}
      ${missing.length ? `<p class="unavail small">Couldn't locate: ${missing.map((h) => esc(h.address)).join("; ")}. Edit or re-add these with a full street address, city and ZIP.</p>` : ""}`;
  } finally {
    btn.disabled = false;
  }
}

function handleIncoming() {
  const params = new URLSearchParams(location.search);
  const shared = { url: params.get("url") || params.get("add") || "", title: params.get("title") || "", text: params.get("text") || "" };
  let msg = null;
  if (shared.url || shared.title || shared.text) {
    const parsed = parseShared(shared);
    if (parsed) {
      const r = addHome(parsed);
      msg = [r.added ? `Added ${parsed.address}.` : `${parsed.address} is already in your list.`, false];
    } else {
      msg = ["Couldn't find an address in what was shared. Paste the listing's address instead.", true];
    }
    for (const k of ["url", "add", "title", "text"]) params.delete(k);
    const clean = new URL(location.href);
    clean.search = params.toString();
    clean.hash = "homes";
    history.replaceState(null, "", clean);
  }
  const m = location.hash.match(/^#homes=([\w-]+)/);
  if (m) {
    try {
      const rows = decodeList(m[1]);
      const added = rows.filter((r) => addHome(r).added).length;
      msg = [`Imported ${added} new home${added === 1 ? "" : "s"} from the shared link (${rows.length - added} already saved).`, false];
    } catch {
      msg = ["That shared list link is damaged.", true];
    }
    history.replaceState(null, "", `${location.pathname}${location.search}#homes`);
  }
  return msg;
}

export function showTab(name) {
  const homes = name === "homes";
  $("#report-view").hidden = homes;
  $("#homes-view").hidden = !homes;
  for (const b of document.querySelectorAll(".tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  if (homes) renderList();
}

export function initHomes() {
  const msg = handleIncoming();

  // Bookmarklet for desktop browsers: sends the current listing page to this site.
  const base = `${location.origin}${location.pathname}`;
  const bm = $("#bookmarklet");
  if (bm) {
    bm.setAttribute("href", `javascript:(()=>{window.open(${JSON.stringify(base)}+'?add='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title),'_blank')})()`);
    bm.addEventListener("click", (e) => { e.preventDefault(); flash("Drag this button to your bookmarks bar, then click it while viewing a listing.", false); });
  }

  for (const b of document.querySelectorAll(".tabs [data-tab]")) {
    b.addEventListener("click", () => {
      history.replaceState(null, "", `${location.pathname}${location.search}${b.dataset.tab === "homes" ? "#homes" : ""}`);
      showTab(b.dataset.tab);
    });
  }

  $("#add-home").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#add-input");
    const value = input.value.trim();
    if (!value) return;
    const parsed = parseShared(/^https?:/i.test(value) ? { url: value } : { text: value });
    if (!parsed) { flash("Couldn't find an address in that. Paste a Zillow, Redfin or Realtor.com listing link, or type the full address.", true); return; }
    const r = addHome(parsed);
    flash(r.added ? `Added ${parsed.address}.` : `${parsed.address} is already in your list.`);
    input.value = "";
    renderList();
  });

  $("#homes-list").addEventListener("change", (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;
    updateHomes((list) => list.map((h) => (h.id === id ? { ...h, selected: e.target.checked } : h)));
    renderStartOptions(loadHomes());
  });

  $("#homes-list").addEventListener("click", async (e) => {
    const removeId = e.target.dataset?.remove;
    const act = e.target.dataset?.act;
    if (removeId) {
      const gone = loadHomes().find((h) => h.id === removeId);
      updateHomes((list) => list.filter((h) => h.id !== removeId));
      flash(`Removed ${gone?.address || "home"}.`);
      renderList();
    } else if (act === "all" || act === "none") {
      updateHomes((list) => list.map((h) => ({ ...h, selected: act === "all" })));
      renderList();
    } else if (act === "remove-selected") {
      const n = loadHomes().filter((h) => h.selected).length;
      if (!n) { flash("Nothing is selected.", true); return; }
      if (!confirm(`Remove ${n} selected home${n === 1 ? "" : "s"}?`)) return;
      updateHomes((list) => list.filter((h) => !h.selected));
      flash(`Removed ${n} home${n === 1 ? "" : "s"}.`);
      renderList();
    } else if (act === "share") {
      const link = `${base}#homes=${encodeList(loadHomes())}`;
      try {
        await navigator.clipboard.writeText(link);
        flash("Link copied. Open it on another device to add these homes there.");
      } catch {
        prompt("Copy this link and open it on another device:", link);
      }
    }
  });

  $("#route-go").addEventListener("click", () => {
    planRoute().catch((err) => { $("#route-result").innerHTML = `<p class="unavail">${esc(err.message)}</p>`; $("#route-go").disabled = false; });
  });

  showTab(location.hash.startsWith("#homes") ? "homes" : "report");
  if (msg) flash(...msg);
  else renderList();
}
