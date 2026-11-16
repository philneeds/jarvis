import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
process.env.JARVIS_UPLOAD_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-lp-"));
const { LeadPerfectionConnector, changesData, isFilterField, postChangesData, sameName, Jarvis, ModelRouter, memoryStore, mockProvider } = await import("../src/index.js");

/**
 * A stand-in for LeadPerfection, built like the real one: ASP.NET WebForms, so every click posts the whole form back
 * with __EVENTTARGET; a login page; Sales › Presentation with a market, a date, and a Sales Rep dropdown per row that
 * only sticks when the floppy-disk Save is clicked; an issued appointment's rep is locked.
 */
interface Appt { id: string; customer: string; time: string; town: string; rep: string; issued?: boolean }
const REPS = ["Dilibeto, Dominic", "Furia, Michael", "Golinitz, Jason", "Irwin, Steven", "Marino, Phillip", "Robak, Ronald", "Singleton, Evan"];
function fakeLeadPerfection(opts: { askCode?: boolean } = {}) {
  const sessions = new Set<string>();
  const days: Record<string, Appt[]> = {
    "11/17/2026": [
      { id: "1", customer: "Slott, Susan", time: "10:00 AM", town: "Rochester", rep: "" },
      { id: "2", customer: "Ross, Karen", time: "1:00 PM", town: "Canandaigua", rep: "" },
      { id: "3", customer: "Ross, Karen", time: "6:00 PM", town: "Canandaigua", rep: "" },
      { id: "4", customer: "Nolan, Bill", time: "2:00 PM", town: "Webster", rep: "Furia, Michael", issued: true },
    ],
  };
  const posts: Record<string, string>[] = [];
  const page = (body: string) => `<!doctype html><html><head><title>LeadPerfection</title><script>function __doPostBack(t,a){var f=document.forms[0];f.__EVENTTARGET.value=t;f.__EVENTARGUMENT.value=a||'';f.submit();}</script></head><body>${body}</body></html>`;
  const login = (msg = "") => page(`<form method="post" action="/login.aspx"><h2>LeadPerfection Login</h2>${msg ? `<p>${msg}</p>` : ""}User <input type="text" name="txtUser"> Password <input type="password" name="txtPass">${opts.askCode ? 'Verification code <input type="text" name="code">' : ""}<input type="submit" name="btnLogin" value="Log In"></form>`);
  const present = (date: string, market: string) => {
    const rows = (days[date] ?? []).map((a) => `<tr><td><select name="rep_${a.id}" ${a.issued ? "disabled" : ""}><option value=""></option>${REPS.map((r, i) => `<option value="${i + 1}" ${r === a.rep ? "selected" : ""}>${r}</option>`).join("")}</select></td><td><a href="javascript:__doPostBack('lnkCust_${a.id}','')">${a.customer}</a> ${a.town}, NY</td><td>${a.time}</td><td>Windows</td><td>${a.issued ? "Issued" : "Set"}</td></tr>`).join("");
    return page(`<form method="post" action="/Present.aspx"><input type="hidden" name="__EVENTTARGET" value=""><input type="hidden" name="__EVENTARGUMENT" value="">
      <h3>Sales Presentation</h3>Market: <select name="ddlMarket" onchange="__doPostBack('ddlMarket','')"><option ${market === "NYRO" ? "selected" : ""}>NYRO - NYRO</option><option ${market === "NYBU" ? "selected" : ""}>NYBU - NYBU</option></select>
      Date: <input type="text" name="txtDate" value="${date}" onchange="__doPostBack('txtDate','')">
      <input type="image" name="btnSave" title="Save" alt="Save" src="/img/save.gif">
      <table><tr><th>Sales Rep</th><th>Customer</th><th>Time</th><th>Product</th><th>Status</th></tr>${rows}</table></form>`);
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sid = /sid=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
      const authed = !!sid && sessions.has(sid);
      const url = new URL(req.url ?? "/", "http://x");
      const send = (html: string, headers: Record<string, string> = {}) => { res.writeHead(200, { "content-type": "text/html", ...headers }); res.end(html); };
      if (url.pathname === "/login.aspx" && req.method === "POST") {
        const f = new URLSearchParams(body);
        if (opts.askCode) return send(login("Enter the verification code we texted you"));
        if (f.get("txtUser") !== "hq" || f.get("txtPass") !== "s3cret") return send(login("Invalid user name or password"));
        const id = Math.random().toString(36).slice(2);
        sessions.add(id);
        res.writeHead(302, { location: "/LeadPerfection.aspx", "set-cookie": `sid=${id}; path=/` }); return res.end();
      }
      if (!authed) return send(login());
      if (url.pathname === "/LeadPerfection.aspx") return send(page("<p>You are logged in as: hq</p>"));
      if (url.pathname === "/Present.aspx") {
        let date = "11/16/2026", market = "NYRO";
        if (req.method === "POST") {
          const f = Object.fromEntries(new URLSearchParams(body));
          posts.push(f);
          date = f.txtDate || date; market = (f.ddlMarket || "NYRO").slice(0, 4);
          // Only the Save button stores the rep dropdowns.
          if ("btnSave.x" in f) for (const a of days[date] ?? []) { const v = f[`rep_${a.id}`]; if (v !== undefined && !a.issued) a.rep = v ? REPS[Number(v) - 1]! : ""; }
        }
        return send(present(date, market));
      }
      res.writeHead(404); res.end("not found");
    });
  });
  return new Promise<{ url: string; days: typeof days; posts: typeof posts; sessions: Set<string>; close: () => void }>((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, days, posts, sessions, close: () => server.close() })));
}

const open: { close(): Promise<void> }[] = [];
after(async () => { for (const c of open) await c.close(); });
async function connect(site: { url: string }, password = "s3cret") {
  const store = memoryStore(); await store.init();
  const lp = new LeadPerfectionConnector(store, { url: site.url, user: "hq", password, timeoutMs: 8000 });
  open.push(lp);
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("g")] } }) });
  jarvis.addConnector(lp, LeadPerfectionConnector.promptHint());
  const tool = (name: string) => jarvis.allTools().find((t) => t.name === name)!;
  const call = (name: string, args: Record<string, unknown>) => tool(name).handler(args as never, { store, agentId: "stevon" });
  return { store, lp, jarvis, call };
}
const ref = (screen: string, pattern: RegExp) => { const m = new RegExp(`\\[(e\\d+)\\][^\\n]*(?:${pattern.source})`, "i").exec(screen); assert.ok(m, `no control matching ${pattern} in:\n${screen.slice(0, 1500)}`); return m[1]!; };

test("the guards: what counts as a change", () => {
  for (const l of ["Save", "btnSave", "Issue", "Create New Appt", "New Lead", "Delete", "Check All", "Transfer", "Log out"]) assert.equal(changesData(l), true, l);
  for (const l of ["Slott, Susan", "Next day", "Search", "Find", "Sales Presentation", "View"]) assert.equal(changesData(l), false, l);
  assert.equal(isFilterField("txtDate"), true);
  assert.equal(isFilterField("Market"), true);
  assert.equal(isFilterField("Last Name"), true);
  assert.equal(isFilterField("Sales Rep"), false);
  assert.equal(isFilterField("ddlStatus"), false);
  assert.equal(isFilterField("Notes"), false);
  assert.equal(postChangesData("__EVENTTARGET=txtDate&txtDate=11%2F17%2F2026"), undefined, "changing the day is reading");
  assert.equal(postChangesData("__EVENTTARGET=&btnSave.x=4&btnSave.y=6"), "btnSave");
  assert.equal(postChangesData("__EVENTTARGET=ddlSalesRep1"), "ddlSalesRep1");
  assert.equal(postChangesData("__EVENTTARGET=lnkIssue"), "lnkIssue");
  assert.equal(sameName("Phillip Marino", "Marino, Phillip"), true);
  assert.equal(sameName("Phil Marino", "Marino, Phillip"), false);
});

test("an agent signs in and reads the day's appointments; filters work, changes are refused", async () => {
  const site = await fakeLeadPerfection();
  try {
    const { call, lp } = await connect(site);
    let screen = await call("lp_open", { screen: "Present.aspx" });
    assert.match(screen, /Sales Presentation/);
    assert.equal(site.sessions.size, 1, "it signed in by itself");
    // Change the day with the date filter: a postback, which is reading.
    screen = await call("lp_fill", { ref: ref(screen, /field "Date:?"|txtDate/), value: "11/17/2026" });
    assert.match(screen, /Slott, Susan/);
    assert.match(screen, /dropdown "Sales Rep" \(rep_1\) = ""; options: Dilibeto, Dominic \| Furia, Michael[^\n]*· row: Slott, Susan Rochester, NY 10:00 AM Windows Set/);
    assert.match(screen, /\(rep_4\) = "Furia, Michael" \(locked\)/);
    // The market dropdown is a filter.
    screen = await call("lp_select", { ref: ref(screen, /\(ddlMarket\)/), option: "NYBU" });
    assert.match(screen, /\(ddlMarket\) = "NYBU - NYBU"/);
    screen = await call("lp_select", { ref: ref(screen, /\(ddlMarket\)/), option: "NYRO" });
    screen = await call("lp_fill", { ref: ref(screen, /txtDate/), value: "11/17/2026" });
    // A rep dropdown, the Save icon, and typing into an appointment field are refused.
    assert.match(await call("lp_select", { ref: ref(screen, /\(rep_1\)/), option: "Marino, Phillip" }), /^Refused: .*isn't a filter dropdown/);
    assert.match(await call("lp_click", { ref: ref(screen, /icon "Save"/) }), /^Refused: .*would change data/);
    assert.equal(site.days["11/17/2026"]![0]!.rep, "", "nothing changed");
    assert.ok(!site.posts.some((p) => "btnSave.x" in p), "no save ever reached the site");
    // Pages outside LeadPerfection, and signing out, aren't opened.
    assert.match(await call("lp_open", { screen: "https://example.com/x" }), /only LeadPerfection's own pages/);
    assert.match(await call("lp_open", { screen: "Logout.aspx" }), /doesn't sign out/);
    // Its session ends on the site: the next look signs in again by itself.
    site.sessions.clear();
    assert.match(await call("lp_open", { screen: "Present.aspx" }), /Sales Presentation/);
    assert.equal((await lp.status()).lastFetch?.ok, true);
  } finally { site.close(); }
});

test("the network guard stops a save even if a click slips past the labels", async () => {
  const site = await fakeLeadPerfection();
  try {
    const { call } = await connect(site);
    await call("lp_open", { screen: "Present.aspx" });
    // A save posted by page script, as if an innocent-looking link ran it.
    const lp = (open[open.length - 1] as unknown as { page: import("playwright-core").Page });
    await lp.page.locator("input[name=txtDate]").fill("11/17/2026");
    await lp.page.evaluate("var f=document.forms[0]; var i=document.createElement('input'); i.type='hidden'; i.name='btnSave.x'; i.value='3'; f.appendChild(i); var s=document.createElement('select'); s.name='rep_1'; s.innerHTML='<option value=5 selected>5</option>'; f.appendChild(s); f.submit();");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(site.days["11/17/2026"]![0]!.rep, "");
    assert.ok(!site.posts.some((p) => "btnSave.x" in p));
  } finally { site.close(); }
});

test("the schedule goes in only through Phil's approval, row by row, checked after saving", async () => {
  const site = await fakeLeadPerfection();
  try {
    const { jarvis, store } = await connect(site);
    const card = await jarvis.requestApproval({ agentId: "stevon", kind: "other", title: "ProEdge schedule for Tue Nov 17", body: "10:00 Slott → Marino; 1:00 Ross → Golinitz", payload: { action: "lp.assign", date: "2026-11-17", market: "NYRO", assignments: [
      { customer: "Slott, Susan", time: "10:00 AM", rep: "Phillip Marino" },
      { customer: "Ross, Karen", time: "1:00 PM", rep: "Golinitz, Jason" },
      { customer: "Ross, Karen", rep: "Robak, Ronald" },
      { customer: "Nolan, Bill", rep: "Irwin, Steven" },
      { customer: "Gone, Nobody", rep: "Irwin, Steven" },
      { customer: "Slott, Susan", time: "10:00 AM", rep: "Somebody Else" },
    ] } });
    assert.equal(card.status, "pending", "a change to LeadPerfection always waits for Phil");
    assert.match(card.effect ?? "", /Enters the sales rep on 6 appointments for 2026-11-17 in LeadPerfection/);
    assert.equal(site.days["11/17/2026"]![0]!.rep, "", "nothing changed before he approved");
    const done = await jarvis.decide(card.id, "approved");
    const day = site.days["11/17/2026"]!;
    assert.equal(day[0]!.rep, "Marino, Phillip");
    assert.equal(day[1]!.rep, "Golinitz, Jason");
    assert.equal(day[2]!.rep, "", "two rows match without a time: not guessed");
    assert.equal(day[3]!.rep, "Furia, Michael", "an issued appointment isn't changed");
    const note = done?.note ?? "";
    assert.match(note, /ProEdge schedule for 11\/17\/2026: 2 of 6 set in LeadPerfection \(Slott, Susan → Marino, Phillip; Ross, Karen → Golinitz, Jason\)/);
    assert.match(note, /Ross, Karen: 2 rows match; give the time on the card/);
    assert.match(note, /Nolan, Bill: the rep can't be changed here \(it shows Furia, Michael; probably issued already\)/);
    assert.match(note, /Gone, Nobody: not on the list for 11\/17\/2026/);
    assert.match(note, /Slott, Susan \(10:00 AM\)|Slott, Susan: no rep "Somebody Else"/);
    assert.match(note, /Not issued to the reps yet/);
    assert.match(note, /Screenshot of 11\/17\/2026: \/api\/uploads\/[\w-]+/);
    // Even when an agent's rules would let a "record" card through, this one waits.
    const { setAgentConfig, getAgentConfig } = await import("../src/index.js");
    const cfg = await getAgentConfig(store, "stevon");
    await setAgentConfig(store, "stevon", { rules: { ...cfg.rules, autoApprove: ["record", "other", "send"] } });
    const again = await jarvis.requestApproval({ agentId: "stevon", kind: "record", title: "x", body: "y", payload: { action: "lp.assign", date: "11/17/2026", assignments: [{ customer: "Ross, Karen", time: "6:00 PM", rep: "Robak, Ronald" }] } });
    assert.equal(again.status, "pending");
  } finally { site.close(); }
});

test("a login that asks for a code, or a wrong password, says so plainly", async () => {
  const coded = await fakeLeadPerfection({ askCode: true });
  try {
    const { call, lp } = await connect(coded);
    assert.match(await call("lp_open", { screen: "Present.aspx" }), /refused the login: it asked for a code or a captcha/);
    assert.equal((await lp.status()).lastFetch?.ok, false);
  } finally { coded.close(); }
  const site = await fakeLeadPerfection();
  try {
    const { call } = await connect(site, "wrong");
    assert.match(await call("lp_open", { screen: "Present.aspx" }), /refused the login: it said the user name or password is wrong/);
  } finally { site.close(); }
});

test("a missing browser says what to run on the server", async () => {
  const store = memoryStore(); await store.init();
  const lp = new LeadPerfectionConnector(store, { url: "http://127.0.0.1:9", user: "hq", password: "x", launch: async () => { throw new Error("browserType.launch: Executable doesn't exist at /home/jarvis/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell"); } });
  await assert.rejects(lp.check(), /isn't installed on the server yet\. On the droplet run: cd \/opt\/jarvis && sudo node packages\/core\/node_modules\/playwright-core\/cli\.js install-deps chromium && sudo -u jarvis -H node .* install --only-shell chromium/);
  assert.equal((await lp.status()).lastFetch?.error, "the browser isn't installed on the server yet");
});
