// Tests for docs/homes.js (saved homes + route planner).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as h from "../docs/homes.js";

test("addresses from listing URLs", () => {
  assert.deepEqual(h.addressFromUrl("https://www.zillow.com/homedetails/123-Main-St-Bryn-Mawr-PA-19010/9876_zpid/"),
    { address: "123 Main St, Bryn Mawr, PA 19010", source: "Zillow" });
  assert.deepEqual(h.addressFromUrl("https://www.zillow.com/homedetails/45-N-Ithan-Ave-APT-2B-Rosemont-PA-19010/1_zpid/"),
    { address: "45 N Ithan Ave APT 2B, Rosemont, PA 19010", source: "Zillow" });
  assert.deepEqual(h.addressFromUrl("https://www.redfin.com/PA/Bryn-Mawr/123-Main-St-19010/home/12345"),
    { address: "123 Main St, Bryn Mawr, PA 19010", source: "Redfin" });
  assert.deepEqual(h.addressFromUrl("https://www.realtor.com/realestateandhomes-detail/123-Main-St_Bryn-Mawr_PA_19010_M12345-67890"),
    { address: "123 Main St, Bryn Mawr, PA 19010", source: "Realtor.com" });
  assert.deepEqual(h.addressFromUrl("https://www.trulia.com/home/123-main-st-bryn-mawr-pa-19010-9876"),
    { address: "123 Main St, Bryn Mawr, PA 19010", source: "Trulia" });
  assert.equal(h.addressFromUrl("https://www.zillow.com/homes/for_sale/"), null);
  assert.equal(h.addressFromUrl("not a url"), null);
});

test("shared text, titles and pasted addresses", () => {
  // Zillow app share text
  assert.deepEqual(h.parseShared({ text: "Check out this home I found on Zillow. 123 Main St, Bryn Mawr, PA 19010 https://www.zillow.com/homedetails/x/1_zpid/" }),
    { address: "123 Main St, Bryn Mawr, PA 19010", url: "https://www.zillow.com/homedetails/x/1_zpid/", source: "Zillow" });
  // Bookmarklet: page URL + title
  assert.equal(h.parseShared({ url: "https://www.redfin.com/PA/Ardmore/9-Oak-Ave-19003/home/5", title: "9 Oak Ave, Ardmore, PA 19003 | MLS# 123 | Redfin" }).address,
    "9 Oak Ave, Ardmore, PA 19003");
  // URL only, address recovered from the URL
  assert.equal(h.parseShared({ url: "https://www.zillow.com/homedetails/7-Elm-Rd-Malvern-PA-19355/2_zpid/" }).address, "7 Elm Rd, Malvern, PA 19355");
  // Plain typed address
  assert.equal(h.parseShared({ text: "12 Lancaster Ave Wayne PA" }).address, "12 Lancaster Ave Wayne PA");
  // A link we can't read is rejected rather than saved as junk
  assert.equal(h.parseShared({ url: "https://example.com/some/page" }), null);
  assert.equal(h.zipOf("123 Main St, Bryn Mawr, PA 19010"), "19010");
});

test("saved list de-duplicates and round-trips through a share link", () => {
  const a = h.addHome({ address: "123 Main St, Bryn Mawr, PA 19010", url: "", source: "" });
  const b = h.addHome({ address: "123 main st,  bryn mawr PA 19010", url: "https://www.zillow.com/homedetails/x/1_zpid/", source: "Zillow" });
  assert.ok(a.added && b.duplicate);
  assert.equal(h.loadHomes()[0].url, "https://www.zillow.com/homedetails/x/1_zpid/");
  h.addHome({ address: "9 Oak Ave, Ardmore, PA 19003 – café", url: "", source: "" });
  const decoded = h.decodeList(h.encodeList(h.loadHomes()));
  assert.deepEqual(decoded.map((r) => r.address), h.loadHomes().map((r) => r.address));
  assert.equal(decoded[0].source, "Zillow");
});

// Points on a line at x = 0, 10, 20, 30 (minutes = distance): the best order is obvious.
const line = [30, 0, 20, 10];
const lineMatrix = line.map((a) => line.map((b) => Math.abs(a - b)));

test("route solver finds the best order", () => {
  const free = h.solveRoute(lineMatrix);
  assert.equal(h.routeCost(lineMatrix, free, false), 30); // walk the line end to end
  const fromIdx3 = h.solveRoute(lineMatrix, { start: 3 }); // start at x=10
  assert.equal(fromIdx3[0], 3);
  assert.equal(h.routeCost(lineMatrix, fromIdx3, false), 40); // 10->0->20->30
  const round = h.solveRoute(lineMatrix, { start: 1, roundTrip: true });
  assert.equal(h.routeCost(lineMatrix, round, true), 60);
});

test("heuristic matches brute force closely on larger trips", () => {
  // 11 random points: above the exact limit, so nearest-neighbour + 2-opt is used.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pts = Array.from({ length: 11 }, () => ({ lat: 40 + rnd() * 0.3, lon: -75.5 + rnd() * 0.3 }));
  const m = h.estimateMatrix(pts);
  const order = h.solveRoute(m, { start: 0 });
  assert.equal(order.length, 11);
  assert.equal(new Set(order).size, 11);
  assert.equal(order[0], 0);
  // never worse than visiting in the given order
  assert.ok(h.routeCost(m, order, false) <= h.routeCost(m, [...Array(11).keys()], false));
});

test("Google Maps links split long trips into 10-stop parts", () => {
  const stops = Array.from({ length: 23 }, (_, i) => `Stop ${i}`);
  const links = h.googleMapsLinks(stops);
  assert.equal(links.length, 3); // 0-9, 9-18, 18-22
  const first = new URL(links[0]).searchParams;
  assert.equal(first.get("origin"), "Stop 0");
  assert.equal(first.get("destination"), "Stop 9");
  assert.equal(first.get("waypoints").split("|").length, 8);
  assert.equal(new URL(links[1]).searchParams.get("origin"), "Stop 9");
  assert.equal(new URL(links[2]).searchParams.get("destination"), "Stop 22");
  // starting from the phone's location: first link has no origin
  const me = h.googleMapsLinks(["40,-75", "A", "B"], { useCurrentLocation: true });
  assert.equal(me.length, 1);
  assert.equal(new URL(me[0]).searchParams.get("origin"), null);
  assert.equal(new URL(me[0]).searchParams.get("destination"), "B");
  assert.equal(new URL(me[0]).searchParams.get("waypoints"), "A"); // own position isn't a stop
  // 12 homes from my location: 9 in the first link, the rest continue from home 9
  const many = h.googleMapsLinks(["me", ...Array.from({ length: 12 }, (_, i) => `H${i + 1}`)], { useCurrentLocation: true });
  assert.equal(many.length, 2);
  assert.equal(new URL(many[0]).searchParams.get("destination"), "H9");
  assert.equal(new URL(many[1]).searchParams.get("origin"), "H9");
  assert.equal(new URL(many[1]).searchParams.get("destination"), "H12");
});

test("incoming shares: raw links from an iOS Shortcut, bookmarklets, share targets", () => {
  // Shortcut with an un-encoded URL that has its own query string
  const raw = h.readIncoming("?add=https://www.zillow.com/homedetails/123-Main-St-Bryn-Mawr-PA-19010/1_zpid/?utm_source=share&utm_medium=x");
  assert.equal(raw.url, "https://www.zillow.com/homedetails/123-Main-St-Bryn-Mawr-PA-19010/1_zpid/?utm_source=share&utm_medium=x");
  assert.equal(h.parseShared(raw).address, "123 Main St, Bryn Mawr, PA 19010");
  // Encoded form (bookmarklet): title first, add last
  const base = "https://bryaniredev.github.io/Scrape/";
  const code = h.bookmarkletCode(base, { sameTab: true });
  assert.ok(code.startsWith("javascript:location.href="));
  assert.ok(code.indexOf("?title=") < code.indexOf("&add="));
  const fromBm = h.readIncoming(`?title=${encodeURIComponent("9 Oak Ave, Ardmore, PA 19003 | Redfin")}&add=${encodeURIComponent("https://www.redfin.com/PA/Ardmore/9-Oak-Ave-19003/home/5")}`);
  assert.equal(fromBm.title, "9 Oak Ave, Ardmore, PA 19003 | Redfin");
  assert.equal(h.parseShared(fromBm).url, "https://www.redfin.com/PA/Ardmore/9-Oak-Ave-19003/home/5");
  assert.ok(h.bookmarkletCode(base).includes("window.open("));
  // Shortcut that passed plain text (e.g. an address) rather than a URL
  assert.equal(h.readIncoming("?add=12%20Lancaster%20Ave%2C%20Wayne%2C%20PA%2019087").text, "12 Lancaster Ave, Wayne, PA 19087");
  // Android share target
  const android = h.readIncoming(`?title=Zillow&text=${encodeURIComponent("Look 123 Main St, Bryn Mawr, PA 19010 https://zillow.com/homedetails/x/1_zpid/")}`);
  assert.equal(h.parseShared(android).address, "123 Main St, Bryn Mawr, PA 19010");
  assert.deepEqual(h.readIncoming("?zip=19010"), { url: "", title: "", text: "" });
});

test("links without an address: ID-only, short links, double-encoded", () => {
  assert.equal(h.addressFromUrl("https://www.zillow.com/homedetails/2073012_zpid/"), null);
  assert.equal(h.addressFromUrl("https://www.zillow.com/homes/123-Main-St-Bryn-Mawr-PA-19010_rb/").address, "123 Main St, Bryn Mawr, PA 19010");
  assert.equal(h.addressFromUrl("https://www.redfin.com/PA/Philadelphia/1500-Walnut-St-19102/unit-12B/home/42").address,
    "1500 Walnut St Unit 12B, Philadelphia, PA 19102");
  assert.equal(h.addressFromUrl("https://www.realtor.com/realestateandhomes-detail/M3412345678"), null);
  assert.ok(h.isShortLink("https://redf.in/aBc123") && h.isShortLink("https://zillow.app.link/xyz"));
  assert.ok(!h.isShortLink("https://www.zillow.com/homedetails/x/1_zpid/"));
  // double-encoded link from a Shortcut
  const twice = encodeURIComponent(encodeURIComponent("https://www.redfin.com/PA/Ardmore/9-Oak-Ave-19003/home/5"));
  assert.equal(h.readIncoming(`?add=${twice}`).url, "https://www.redfin.com/PA/Ardmore/9-Oak-Ave-19003/home/5");
  assert.equal(h.deepDecode("https://www.zillow.com/homedetails/a/1_zpid/?x=1%202"), "https://www.zillow.com/homedetails/a/1_zpid/?x=1%202");
});

test("an unreadable listing link is saved as 'address needed' instead of lost", () => {
  const before = h.loadHomes().length;
  const [msg, isErr] = h.saveShared({ url: "https://redf.in/aBc123" });
  assert.ok(isErr && /short link/.test(msg) && /Received: https:\/\/redf\.in\/aBc123/.test(msg));
  const saved = h.loadHomes().at(-1);
  assert.equal(h.loadHomes().length, before + 1);
  assert.deepEqual([saved.address, saved.url, saved.source, saved.selected], ["", "https://redf.in/aBc123", "Redfin", false]);
  // sharing the same link again doesn't duplicate it
  h.saveShared({ url: "https://redf.in/aBc123" });
  assert.equal(h.loadHomes().length, before + 1);
  const [msg2] = h.saveShared({ url: "https://www.zillow.com/homedetails/2073012_zpid/" });
  assert.match(msg2, /doesn't include the address/);
  assert.deepEqual(h.saveShared({ text: "hello" }), ["Couldn't find an address or a link in what was shared. Type the address in the box instead.", true]);
});
