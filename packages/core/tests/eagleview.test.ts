import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, EagleViewConnector, takeoff, takeoffText, CHARTERS, connectionsFor, AGENTS, OPTIONAL_CONNECTIONS } from "../src/index.js";

/** A fake EagleView: client-credentials token, a product list, a report list, one report with totals, PlaceOrder. */
function fakeEagleView() {
  const calls: { method: string; path: string; headers: Record<string, string>; body?: string }[] = [];
  const orders: Record<string, unknown>[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)); const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, headers, body: init?.body as string | undefined });
    if (u.pathname === "/oauth2/v1/token") {
      if (headers.authorization !== `Basic ${Buffer.from("app1:s3cret").toString("base64")}`) return Response.json({ error: "invalid_client", error_description: "Bad credentials" }, { status: 401 });
      return Response.json({ access_token: "tok-1", token_type: "Bearer", expires_in: 86400 });
    }
    if (headers.authorization !== "Bearer tok-1") return Response.json({ message: "Unauthorized" }, { status: 401 });
    if (u.pathname === "/v2/Product/GetAvailableProducts") return Response.json([
      { productID: 31, name: "Premium - Residential", priceMin: 32.75, priceMax: 87, deliveryProducts: [{ productID: 8, name: "Regular", priceMin: 0 }, { productID: 45, name: "Quick Delivery", priceMin: 0 }] },
      { productID: 84, name: "Bid Perfect", priceMin: 18, priceMax: 18 },
      { productID: 99, name: "Whole Home", isTemporarilyUnavailable: true, priceMin: 105 },
    ]);
    if (u.pathname === "/reports") return Response.json({ Reports: [
      { Id: 41001465, Street1: "260 Longridge Ave", City: "Rochester", State: "NY", Zip: "14621", DatePlaced: "2026-11-15T14:00:00Z", DateCompleted: "2026-11-15T16:30:00Z", ReportStatus: { Status: "Completed", DisplayStatus: "Completed" }, ReportProducts: [{ Name: "Premium" }], ReferenceId: "d005c62d" },
      { Id: 41001466, Street1: "12 Elm St", City: "Rochester", State: "NY", Zip: "14607", DatePlaced: "2026-11-15T15:00:00Z", ReportStatus: { Status: "In Process", DisplayStatus: "In Process" }, ReportProducts: [{ Name: "Bid Perfect" }] },
    ], TotalOfReports: 2 });
    if (u.pathname === "/v3/Report/GetReport" && u.searchParams.get("reportId") === "41001465") return Response.json({
      Id: 41001465, Street1: "260 Longridge Ave", City: "Rochester", State: "NY", Zip: "14621", Latitude: 43.19, Longitude: -77.6, DatePlaced: "2026-11-15T14:00:00Z", DateCompleted: "2026-11-15T16:30:00Z",
      ReportStatus: { StatusId: 6, Status: "Completed" }, ReportDownloadLink: "https://files.eagleview.com/r/41001465.pdf",
      MeasurementTotals: { TotalArea: 1830, Squares: 18.3, PredominantPitch: "7/12", RidgeLength: 42.5, HipLength: 0, ValleyLength: 31, EaveLength: 118.2, RakeLength: 64, StepFlashingLength: 12, NumberOfFacets: 6 },
    });
    if (u.pathname === "/v3/Report/GetReport" && u.searchParams.get("reportId") === "41001466") return new Response(null, { status: 204 });
    if (u.pathname === "/v2/Order/PlaceOrder" && init?.method === "POST") { orders.push(JSON.parse(String(init.body))); return Response.json({ OrderId: 26998516, ReportIds: [41001470] }); }
    return Response.json({ message: "not found" }, { status: 404 });
  }) as typeof fetch;
  return { f, calls, orders };
}

test("EagleView: client-credentials token once, then reports, one report's measured takeoff and the price list, all read-only", async () => {
  const store = memoryStore(); await store.init();
  const now = Date.parse("2026-11-15T20:00:00Z");
  const { f, calls } = fakeEagleView();
  const ev = new EagleViewConnector(store, { clientId: "app1", clientSecret: "s3cret", fetch: f, now: () => now });
  assert.equal(await ev.check(), "Connected to EagleView: 3 products orderable, e.g. Premium - Residential, Bid Perfect, Whole Home.");
  const tok = calls.find((c) => c.path === "/oauth2/v1/token")!;
  assert.equal(tok.method, "POST");
  assert.equal(tok.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(tok.body, "grant_type=client_credentials");
  assert.equal(calls[0]!.path, "/oauth2/v1/token", "the token comes first");
  assert.equal(calls[1]!.path, "/v2/Product/GetAvailableProducts");
  assert.equal(calls[1]!.headers.authorization, "Bearer tok-1");
  const t = (name: string) => ev.tools().find((x) => x.name === name)!;
  const ctx = { store, agentId: "bill" };
  const list = await t("eagleview_reports").handler({}, ctx);
  assert.match(list, /^\[41001465\] 260 Longridge Ave, Rochester, NY, 14621 · Completed · Premium · placed Nov 15, 9:00 AM, done Nov 15, 11:30 AM · ref d005c62d\n\[41001466\] 12 Elm St, Rochester, NY, 14607 · In Process · Bid Perfect · placed Nov 15, 10:00 AM$/);
  assert.match(await t("eagleview_reports").handler({ query: "longridge" }, ctx), /^\[41001465\][^\n]*$/);
  assert.match(await t("eagleview_reports").handler({ query: "nowhere" }, ctx), /No EagleView report matches "nowhere"/);
  const rep = await t("eagleview_report").handler({ reportId: "41001465" }, ctx);
  assert.match(rep, /\[41001465\] 260 Longridge Ave, Rochester, NY, 14621 · Completed/);
  assert.match(rep, /Roof: 18\.3 squares \(1,830 sq ft\), predominant pitch 7\/12, 6 facets\nRidge 43 ft · Hip 0 ft · Valley 31 ft · Eave 118 ft · Rake 64 ft · Step flashing 12 ft/);
  assert.match(rep, /Report file: https:\/\/files\.eagleview\.com\/r\/41001465\.pdf/);
  assert.doesNotMatch(rep, /Latitude|StatusId/, "ids and coordinates aren't passed off as measurements");
  assert.match(await t("eagleview_report").handler({ reportId: "41001466" }, ctx), /no report 41001466 .*isn't ready: HTTP 204/);
  const prods = await t("eagleview_products").handler({}, ctx);
  assert.match(prods, /^\[31\] Premium - Residential · \$32\.75–\$87\.00 · delivery: Regular, Quick Delivery\n\[84\] Bid Perfect · \$18\.00$/, "an unavailable product is left out");
  assert.ok(calls.filter((c) => c.path !== "/oauth2/v1/token").every((c) => c.method === "GET"), "reads never write");
  assert.equal(calls.filter((c) => c.path === "/oauth2/v1/token").length, 1, "one token for the whole run");
  const n = calls.length; await t("eagleview_products").handler({}, ctx); assert.equal(calls.length, n, "cached for a minute");
  assert.equal((await ev.status()).lastFetch?.ok, true);
  const bad = new EagleViewConnector(store, { clientId: "app1", clientSecret: "wrong", fetch: f, now: () => now });
  assert.match(await bad.tools()[0]!.handler({}, ctx), /^EagleView: EagleView refused the credentials \(Bad credentials\)\. Check EAGLEVIEW_CLIENT_ID/);
  assert.match((await bad.status()).lastFetch?.error ?? "", /refused the credentials/);
  // The JD PM estimators read it; nobody else does. EagleView is optional: a missing key never holds up setup.
  for (const id of ["stella", "jake", "bill", "frog"]) assert.ok(CHARTERS[id]!.tools!.includes("eagleview_report"), `${id} reads EagleView`);
  for (const id of ["karol", "stephanie", "brian", "stevon", "munger"]) assert.ok(!CHARTERS[id]!.tools!.some((x) => x.startsWith("eagleview_")), `${id} has no business with EagleView`);
  assert.ok(connectionsFor(AGENTS.find((a) => a.id === "bill")!).includes("EagleView"));
  assert.ok(OPTIONAL_CONNECTIONS.includes("EagleView"));
});

test("the takeoff reader copes with the names EagleView uses and says plainly when it finds none", () => {
  const a = takeoff({ Id: 1, Latitude: 43.1, Longitude: -77.6, roof: { totalArea: "2450", pitch: 6, ridge: 50, hips: 20, valleys: 10, eaves: 140, rakes: 70, flashing: 8 } });
  assert.equal(a.areaSqFt, 2450); assert.equal(a.squares, 24.5, "squares derived from area when EagleView gives only area");
  assert.equal(a.pitch, "6"); assert.equal(a.ridgeFt, 50); assert.equal(a.hipFt, 20); assert.equal(a.valleyFt, 10); assert.equal(a.eaveFt, 140); assert.equal(a.rakeFt, 70); assert.equal(a.flashingFt, 8);
  assert.deepEqual(a.other, {}, "coordinates and ids are not 'other numbers'");
  const b = takeoff({ Id: 2, Facets: 9, WasteFactor: 12, Structure: { Lengths: { Rake: 33 } } });
  assert.equal(b.facets, 9); assert.equal(b.rakeFt, 33);
  assert.match(takeoffText(b), /No measurement totals under the names HQ knows; numbers in the report: WasteFactor=12/);
  assert.match(takeoffText(takeoff({ Id: 3, Status: "In Process" })), /No measurement totals in the report yet/);
});

test("ordering a report is money: it waits for Phil whatever kind the agent wrote, the card prices it, and PlaceOrder runs only on approval, tied to the GoHighLevel contact", async () => {
  const store = memoryStore(); await store.init();
  const now = Date.parse("2026-11-15T20:00:00Z");
  const { f, orders } = fakeEagleView();
  const { Jarvis } = await import("../src/index.js");
  const jarvis = new Jarvis({ store });
  const ev = new EagleViewConnector(store, { clientId: "app1", clientSecret: "s3cret", fetch: f, now: () => now });
  jarvis.addConnector(ev, EagleViewConnector.promptHint());
  // Bill files it as "other" by mistake: the action is still money, so Phil's "only outbound waits" rule for JD PM can't let it through.
  const a = await jarvis.requestApproval({ agentId: "bill", kind: "other", title: "EagleView report for Tracy", body: "Measured takeoff for the 260 Longridge roof before materials are ordered.", payload: { action: "eagleview.order", address: "260 Longridge Ave", city: "Rochester", state: "NY", zip: "14621", product: "Premium", structures: "primary+garage", contactId: "c-tracy", jobId: "d005c62d", squares: 15 } });
  assert.equal(a.status, "pending", "a paid order waits for Phil");
  assert.equal((a.payload as { estimate?: string }).estimate, "$32.75–$87.00 (your account's price)", "the card carries the account's price");
  assert.match(a.effect ?? "", /Places a paid EagleView Premium \(residential\) order for 260 Longridge Ave, Rochester, billed to JD PM's EagleView account the moment you approve: \$32\.75–\$87\.00 \(your account's price\)\. Nothing is sent to the customer\./);
  assert.equal(orders.length, 0, "nothing ordered yet");
  const done = await jarvis.decide(a.id, "approved", "go");
  assert.equal(done?.status, "approved");
  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0], { OrderReports: [{ ReportAddresses: [{ Address: "260 Longridge Ave", City: "Rochester", State: "NY", Zip: "14621", Country: "US", AddressType: 1 }], PrimaryProductId: 31, DeliveryProductId: 8, MeasurementInstructionType: 1, ReferenceId: "d005c62d", Comments: "" }], PromoCode: "" });
  assert.match(done?.note ?? "", /Ordered an EagleView Premium \(residential\) report for 260 Longridge Ave, Rochester \(regular delivery, house plus detached garage\): report 41001470, order 26998516\. Read it with eagleview_report 41001470 .*ghl\.note on contact c-tracy/);
  const kept = await ev.orders();
  assert.equal(kept["41001470"]!.contactId, "c-tracy"); assert.equal(kept["41001470"]!.jobId, "d005c62d"); assert.equal(kept["41001470"]!.agentId, "bill");
  // Without the live list the card still says what it costs, from EagleView's published price by roof size.
  assert.equal(EagleViewConnector.estimate("premium", 15), "$32.75 (EagleView list price; a partner or volume tier is lower)");
  assert.equal(EagleViewConnector.estimate("premium", 30), "$60.00 (EagleView list price; a partner or volume tier is lower)");
  assert.equal(EagleViewConnector.estimate("bid-perfect"), "$18.00 (EagleView list price; a partner or volume tier is lower)");
  // A bad product never reaches EagleView.
  const bad = await jarvis.requestApproval({ agentId: "bill", kind: "money", title: "Bad", body: "x", payload: { action: "eagleview.order", address: "1 Main St", city: "Rochester", state: "NY", zip: "14604", product: "solar" } });
  const r = await jarvis.decide(bad.id, "approved");
  assert.match(r?.note ?? "", /unknown product "solar"; use premium, quicksquares, bid-perfect, gutter/);
  assert.equal(orders.length, 1);
});
