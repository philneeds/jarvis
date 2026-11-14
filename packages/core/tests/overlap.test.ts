import { test } from "node:test";
import assert from "node:assert/strict";
import { Jarvis, ModelRouter, memoryStore, mockProvider } from "../src/index.js";
import { supersedes, slot, slotsOverlap } from "../src/jarvis/overlap.js";
import { GoogleConnector } from "../src/connectors/google.js";

function make() {
  const store = memoryStore();
  const router = new ModelRouter({ store, providers: { claude: [mockProvider("mock-claude")], grok: [mockProvider("mock-grok")] } });
  return { jarvis: new Jarvis({ store, router }), store };
}

const cal = (title: string, start: string, end: string, recurrence?: string) => ({ action: "calendar.create", account: "pmarino@getproedge.com", title, start, end, attendees: ["mbetter@getproedge.com"], ...(recurrence && { recurrence }) });

test("a revised card replaces the agent's older pending card for the same slot (the Nov 13 ProEdge week)", async () => {
  const { jarvis, store } = make();
  const ask = (runId: string, title: string, payload: Record<string, unknown>) => jarvis.requestApproval({ agentId: "monica", kind: "record", title, body: "", payload, runId });
  // Run 1: three blocks.
  const m1 = await ask("r1", "Morning leads", cal("Leads (morning)", "2026-11-16T09:00:00-05:00", "2026-11-16T11:00:00-05:00", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,TH,FR"));
  const a1 = await ask("r1", "Afternoon leads Mon-Fri", cal("Leads (afternoon)", "2026-11-16T13:00:00-05:00", "2026-11-16T17:00:00-05:00", "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"));
  const n1 = await ask("r1", "Nightly", cal("Team coordination + lead send-out", "2026-11-16T21:00:00-05:00", "2026-11-16T22:00:00-05:00", "RRULE:FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH"));
  assert.equal((await store.approvals.list("pending")).length, 3, "cards from one run never replace each other");
  // Run 2: the revised week, renamed and started a day earlier for the nightly block.
  const m2 = await ask("r2", "Morning leads", cal("Morning leads", "2026-11-16T09:00:00", "2026-11-16T11:00:00", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,TH,FR"));
  await ask("r2", "Afternoon leads", cal("Afternoon leads", "2026-11-16T13:00:00", "2026-11-16T17:00:00", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,TH,FR"));
  await ask("r2", "Tuesday leads", cal("Tuesday leads", "2026-11-17T14:00:00", "2026-11-17T19:00:00", "RRULE:FREQ=WEEKLY;BYDAY=TU"));
  await ask("r2", "Nightly", cal("Team coordination + lead send-out", "2026-11-15T21:00:00", "2026-11-15T22:00:00", "RRULE:FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH"));
  const pending = await store.approvals.list("pending");
  assert.deepEqual(pending.map((p) => p.runId), ["r2", "r2", "r2", "r2"], "only the latest plan waits");
  for (const old of [m1, a1, n1]) {
    const now = await store.approvals.get(old.id);
    assert.equal(now?.status, "rejected");
    assert.match(now?.note ?? "", /^superseded/);
  }
  assert.match((await store.approvals.get(m2.id))!.effect ?? "", /Replaces the older card: "Morning leads"/);
});

test("different slots, other agents and other calendars are left alone", async () => {
  const { jarvis, store } = make();
  await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Dentist", body: "", runId: "r1", payload: cal("Dentist", "2026-11-18T09:00:00", "2026-11-18T10:00:00") });
  await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Lunch", body: "", runId: "r2", payload: cal("Lunch", "2026-11-18T12:00:00", "2026-11-18T13:00:00") });
  await jarvis.requestApproval({ agentId: "monica", kind: "record", title: "Other cal", body: "", runId: "r3", payload: { ...cal("Dentist", "2026-11-18T09:00:00", "2026-11-18T10:00:00"), account: "philneedsofficial@gmail.com" } });
  await jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Mike", body: "", runId: "r4", payload: { action: "gmail.send", to: "mike@x.com", subject: "Install" } });
  await jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Dana", body: "", runId: "r5", payload: { action: "gmail.send", to: "dana@x.com", subject: "Install" } });
  assert.equal((await store.approvals.list("pending")).length, 5);
  // The same email revised: the older one goes.
  await jarvis.requestApproval({ agentId: "stella", kind: "send", title: "Email Mike v2", body: "", runId: "r6", payload: { action: "gmail.send", to: "Mike@x.com", subject: "Re: Install" } });
  const titles = (await store.approvals.list("pending")).map((p) => p.title).sort();
  assert.deepEqual(titles, ["Dentist", "Email Dana", "Email Mike v2", "Lunch", "Other cal"]);
});

test("slot overlap reads weekdays from the rule and ignores one-offs before a series starts", () => {
  const tue = slot(cal("Tue", "2026-11-17T14:00:00", "2026-11-17T19:00:00", "RRULE:FREQ=WEEKLY;BYDAY=TU"))!;
  const mwthf = slot(cal("Aft", "2026-11-16T13:00:00", "2026-11-16T17:00:00", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,TH,FR"))!;
  const monfri = slot(cal("Aft", "2026-11-16T13:00:00", "2026-11-16T17:00:00", "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"))!;
  assert.equal(slotsOverlap(tue, mwthf), false, "no shared weekday");
  assert.equal(slotsOverlap(tue, monfri), true, "Tuesday 2-5 is in both");
  const after = slot(cal("Once", "2026-11-24T14:00:00", "2026-11-24T15:00:00"))!;
  assert.equal(slotsOverlap(after, tue), true, "same weekday and hour, inside the series");
  const earlier = slot(cal("Once", "2026-11-03T14:00:00", "2026-11-03T15:00:00"))!;
  assert.equal(slotsOverlap(earlier, slot(cal("Tue", "2026-11-10T14:00:00", "2026-11-10T19:00:00", "RRULE:FREQ=WEEKLY;BYDAY=TU"))!), false, "one-off before the series starts");
  assert.equal(supersedes({ agentId: "monica", title: "x", runId: "a", payload: cal("x", "2026-11-17T14:00:00", "2026-11-17T15:00:00") }, { agentId: "monica", title: "x", runId: "a", status: "pending", payload: cal("x", "2026-11-17T14:00:00", "2026-11-17T15:00:00") }), false, "same run");
});

test("calendar.create keeps the repeat rule and the zone", () => {
  const g = new GoogleConnector(memoryStore(), { clientId: "x", clientSecret: "y" } as never);
  const body = g.eventBody({ title: "Morning leads", start: "2026-11-16T09:00:00-05:00", end: "2026-11-16T11:00:00-05:00", recurrence: "FREQ=WEEKLY;BYDAY=MO,WE", timeZone: "America/New_York" }) as { recurrence?: string[]; start?: { timeZone?: string } };
  assert.deepEqual(body.recurrence, ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]);
  assert.equal(body.start?.timeZone, "America/New_York");
  const once = g.eventBody({ title: "x", start: "2026-11-16T09:00:00-05:00", end: "2026-11-16T10:00:00-05:00" }) as { recurrence?: unknown; start?: { timeZone?: string } };
  assert.equal(once.recurrence, undefined);
  assert.equal(once.start?.timeZone, undefined);
});

test("never replaced: different customers, money and trades, same title on another day, all-day vs timed, a card Phil edited", async () => {
  const { jarvis, store } = make();
  const ask = (agentId: string, runId: string, title: string, payload: Record<string, unknown>, kind: "record" | "send" | "money" = "record") => jarvis.requestApproval({ agentId, kind, title, body: "", payload, runId });
  await ask("stephanie", "r1", "Reply to new lead", { action: "ghl.message", contactId: "A", message: "hi A" }, "send");
  await ask("stephanie", "r2", "Reply to new lead", { action: "ghl.message", contactId: "B", message: "hi B" }, "send");
  await ask("mayne", "r3", "Long ETH", { action: "trade.execute", symbol: "ETH", side: "long", sizeUsd: 100, strategy: "A" }, "money");
  await ask("mayne", "r4", "Long ETH", { action: "trade.execute", symbol: "ETH", side: "long", sizeUsd: 50, strategy: "B" }, "money");
  const gymMon = await ask("lip", "r5", "Gym", { action: "calendar.create", account: "philneedsofficial@gmail.com", title: "Gym", start: "2026-11-16T07:00:00", end: "2026-11-16T08:00:00", attendees: ["coach@x.com"] });
  await ask("lip", "r6", "Gym", { action: "calendar.create", account: "philneedsofficial@gmail.com", title: "Gym", start: "2026-11-19T07:00:00", end: "2026-11-19T08:00:00", attendees: ["coach@x.com"] });
  await ask("lip", "r7", "Birthday", { action: "calendar.create", account: "philneedsofficial@gmail.com", title: "Mom's birthday", start: "2026-11-16", end: "2026-11-17", attendees: ["mom@x.com"] });
  assert.equal((await store.approvals.list("pending")).length, 7, "nothing replaced anything");
  // Phil edits a card; a revision of it from a later run doesn't throw his edit away.
  await jarvis.updateApproval(gymMon.id, { body: "Make it 6:30" });
  await ask("lip", "r8", "Gym (revised)", { action: "calendar.create", account: "philneedsofficial@gmail.com", title: "Gym", start: "2026-11-16T07:00:00", end: "2026-11-16T08:00:00", attendees: ["coach@x.com"] });
  assert.equal((await store.approvals.get(gymMon.id))?.status, "pending");
});

test("replaced: the same slot written in two time formats, the same customer thread, the newest memory condense", async () => {
  const { jarvis, store } = make();
  const ask = (agentId: string, runId: string, title: string, payload: Record<string, unknown>, kind: "record" | "send" = "record") => jarvis.requestApproval({ agentId, kind, title, body: "", payload, runId });
  const utc = await ask("monica", "r1", "Call", cal("Call", "2026-11-18T19:00:00Z", "2026-11-18T20:00:00Z"));
  await ask("monica", "r2", "Call", cal("Call", "2026-11-18T14:00:00-05:00", "2026-11-18T15:00:00-05:00"));
  assert.equal((await store.approvals.get(utc.id))?.status, "rejected", "2pm Eastern is 19:00 UTC");
  const t1 = await ask("stephanie", "r3", "Reply to Ana", { action: "ghl.message", contactId: "ana", message: "v1" }, "send");
  await ask("stephanie", "r4", "Reply to Ana (better)", { action: "ghl.message", contactId: "ana", message: "v2" }, "send");
  assert.equal((await store.approvals.get(t1.id))?.status, "rejected");
  const c1 = await ask("oscar", "r5", "Condense memory 40 → 30", { action: "memory.replace", keep: [] });
  await ask("oscar", "r6", "Condense memory 41 → 31", { action: "memory.replace", keep: [] });
  assert.equal((await store.approvals.get(c1.id))?.status, "rejected");
  // Times written in Phil's own clock and in UTC compare correctly.
  assert.equal(slotsOverlap(slot({ start: "2026-11-18T09:00:00", end: "2026-11-18T10:00:00" }), slot({ start: "2026-11-18T14:00:00Z", end: "2026-11-18T15:00:00Z" })), true);
  assert.equal(slotsOverlap(slot({ start: "2026-11-18", end: "2026-11-19" }), slot({ start: "2026-11-18T09:00:00", end: "2026-11-18T10:00:00" })), false);
  assert.equal(slotsOverlap(slot({ start: "2026-11-02T09:00:00", end: "2026-11-02T10:00:00", recurrence: "RRULE:FREQ=MONTHLY" }), slot({ start: "2026-11-09T09:00:00", end: "2026-11-09T10:00:00" })), false, "monthly isn't weekly");
});
