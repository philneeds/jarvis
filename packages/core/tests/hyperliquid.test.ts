import { test } from "node:test";
import assert from "node:assert/strict";
import { hyperliquidPerps, perpsText, CHARTERS, SCHEDULES } from "../src/index.js";

test("Hyperliquid: funding, open interest and moves read from the public feed; Pentoshi's scan uses it", async () => {
  const body = [
    { universe: [{ name: "BTC" }, { name: "DEAD", isDelisted: true }, { name: "WLD" }, { name: "TINY" }] },
    [
      { funding: "0.0000125", openInterest: "40000", markPx: "76000", prevDayPx: "80000", dayNtlVlm: "4800000000" },
      { funding: "0.1", openInterest: "1", markPx: "1", prevDayPx: "1", dayNtlVlm: "0" },
      { funding: "-0.000083", openInterest: "120000000", markPx: "0.35", prevDayPx: "0.38", dayNtlVlm: "51700000" },
      { funding: "0.001", openInterest: "100", markPx: "0.5", prevDayPx: "0.5", dayNtlVlm: "10" },
    ],
  ];
  let sent: unknown;
  const f = (async (_u: string | URL | Request, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify(body)); }) as typeof fetch;
  const rows = await hyperliquidPerps(f);
  assert.deepEqual(sent, { type: "metaAndAssetCtxs" });
  assert.deepEqual(rows.map((r) => r.coin), ["BTC", "WLD", "TINY"], "delisted markets are dropped");
  const text = perpsText(rows);
  assert.match(text, /BTC: 76,000 \(-5\.0% 24h\) · funding \+0\.0013%\/h \(\+10\.9% APR\) · OI \$3\.04B · vol \$4\.80B/);
  assert.match(text, /Most negative funding \(shorts paying\):\nWLD: 0\.3500 \(-7\.9% 24h\) · funding -0\.0083%\/h/);
  assert.doesNotMatch(text, /TINY/, "markets under $1M open interest stay out of the lists");
  assert.match(perpsText(rows, ["btc", "nope"]), /^BTC: [\s\S]*Not listed on Hyperliquid: NOPE\.$/);
  assert.ok(CHARTERS.pentoshi!.tools!.includes("hyperliquid_perps"));
  assert.match(SCHEDULES.find((s) => s.id === "pentoshi-scan")!.task, /hyperliquid_perps/);
});
