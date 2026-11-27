import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
process.env.JARVIS_UPLOAD_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-deckfill-"));
const { memoryStore, Jarvis, ModelRouter, mockProvider, setTemplate, getTemplate, templateText, templateListing, fillTemplate, normalizeFill, loadFile, deckFile } = await import("../src/index.js");
const { extractBlocks } = await import("../src/jarvis/blocks.js");

/** A real .pptx made by hand: two slides, a run split in two (as PowerPoint often saves), a table cell, a picture. */
async function template(): Promise<Buffer> {
  const zip = new JSZip();
  const sp = (paras: string[]) => `<p:sp><p:txBody>${paras.map((p) => `<a:p>${p}</a:p>`).join("")}</p:txBody></p:sp>`;
  const run = (t: string, b = false) => `<a:r><a:rPr lang="en-US"${b ? ' b="1"' : ""}/><a:t>${t}</a:t></a:r>`;
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>');
  zip.file("ppt/presentation.xml", '<p:presentation><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
  zip.file("ppt/theme/theme1.xml", '<a:theme><a:dk1><a:srgbClr val="1F3A5F"/></a:dk1><a:accent1><a:srgbClr val="7AB648"/></a:accent1><a:majorFont><a:latin typeface="Montserrat"/></a:majorFont><a:minorFont><a:latin typeface="Lato"/></a:minorFont></a:theme>');
  zip.file("ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree>${sp([run("ProEdge Weekly Sales"), run("Week of 11/02 &amp; 11/08")])}<p:pic><a:blip r:embed="rId2"/></p:pic></p:spTree></p:cSld></p:sld>`);
  zip.file("ppt/slides/slide2.xml", `<p:sld><p:cSld><p:spTree>${sp([run("Close rate: ", true) + run("15.0%"), run("NSLI $1,900")])}<a:tbl><a:tr><a:tc><a:txBody><a:p>${run("Marino")}</a:p></a:txBody></a:tc><a:tc><a:txBody><a:p>${run("40%")}</a:p></a:txBody></a:tc></a:tr></a:tbl></p:spTree></p:cSld></p:sld>`);
  zip.file("ppt/media/image1.png", Buffer.from("logo-bytes"));
  return zip.generateAsync({ type: "nodebuffer" });
}

test("Phil's template is filled in: only the quoted text changes; layout, formatting and pictures stay", async () => {
  const store = memoryStore(); await store.init();
  const tpl = await setTemplate(store, "proedge", "Weekly Sales.pptx", await template());
  // The outline shows each paragraph whole (a run split in two reads as one), so the agent can quote it.
  assert.equal(tpl.outline[1], "Close rate: 15.0% · NSLI $1,900 · Marino · 40%");
  assert.match(templateText(await getTemplate(store, "proedge")), /use a deckfill block quoting its text exactly/);
  const spec = normalizeFill({ title: "ProEdge weekly sales 11/09-11/15", edits: [
    { slide: 1, find: "Week of 11/02 & 11/08", replace: "Week of 11/09 & 11/15" },
    { slide: 2, find: "Close rate: 15.0%", replace: "Close rate: 17.5%" },
    { slide: 2, find: "NSLI $1,900", replace: "NSLI $2,358" },
    { slide: 2, find: "40%", replace: "50%" },
    { slide: 2, find: "Demo rate", replace: "Demo rate 67%" },
    { slide: 9, find: "x", replace: "y" },
  ] })!;
  const { deck, missed, done } = await fillTemplate(store, spec, { agentId: "stevon", venture: "proedge" });
  assert.equal(done, 4);
  assert.deepEqual(missed.map((m) => `${m.slide}:${m.find}`), ["2:Demo rate", "9:x"], "what isn't in the template is reported, not guessed");
  const out = await JSZip.loadAsync((await loadFile(deck.fileId))!.data);
  const s1 = await out.file("ppt/slides/slide1.xml")!.async("string"), s2 = await out.file("ppt/slides/slide2.xml")!.async("string");
  assert.match(s1, /<a:t>Week of 11\/09 &amp; 11\/15<\/a:t>/, "text is escaped back into XML");
  assert.match(s1, /<p:pic><a:blip r:embed="rId2"\/><\/p:pic>/, "the picture is untouched");
  assert.equal((await out.file("ppt/media/image1.png")!.async("nodebuffer")).toString(), "logo-bytes");
  assert.match(s2, /<a:r><a:rPr lang="en-US" b="1"\/><a:t>Close rate: 17\.5%<\/a:t><\/a:r><a:r><a:rPr lang="en-US"\/><a:t><\/a:t><\/a:r>/, "the first run keeps its bold and takes the whole new text");
  assert.match(s2, /<a:t>NSLI \$2,358<\/a:t>/);
  assert.match(s2, /<a:tc><a:txBody><a:p><a:r><a:rPr lang="en-US"\/><a:t>50%<\/a:t>/, "table cells too");
  assert.equal(await out.file("ppt/theme/theme1.xml")!.async("string"), await (await JSZip.loadAsync(await template())).file("ppt/theme/theme1.xml")!.async("string"));
  assert.equal(deck.title, "ProEdge weekly sales 11/09-11/15");
  assert.ok((await deckFile(store, deck.id))?.data.length);
});

test("a deckfill block in an agent's reply becomes the filled-in deck in chat", async () => {
  const store = memoryStore(); await store.init();
  await setTemplate(store, "proedge", "Weekly Sales.pptx", await template());
  const provider = mockProvider("m");
  provider.run = async (req) => ({ text: `Here's this week's deck.\n\n\`\`\`deckfill\n${JSON.stringify({ title: "ProEdge weekly sales", edits: [{ slide: 2, find: "Close rate: 15.0%", replace: "Close rate: 17.5%" }, { slide: 2, find: "Nope", replace: "x" }] })}\n\`\`\``, provider: "m", modelId: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 });
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  const { getAgent } = await import("../src/index.js");
  const r = await jarvis.runAgent(getAgent("stevon")!, "Fill in the deck", { direct: true });
  assert.match(r.text, /\[Deck ready: ProEdge weekly sales\]/);
  const chat = await store.chat.list(10);
  // The same edits came back on the check pass (the stand-in model can't do better), so Phil gets that deck with its
  // problems named: the edit that missed and the template numbers left as they were.
  const msg = chat.find((m) => /Deck ready: ProEdge weekly sales · your template with 1 change\. Check before using it: 1 edit types a sales figure by hand instead of a \{\{code\}\}: slide 2 "Close rate: 17\.5%"\. 1 edit didn't match and weren't made: slide 2 "Nope"\. 3 paragraphs still carry the template's own numbers, unchanged: slide 1 \[2\] "Week of 11\/02 & 11\/08"; slide 2 \[2\] "NSLI \$1,900"; slide 2 \[4\] "40%"/.test(m.text));
  assert.ok(msg?.files?.length, "the file is handed over in chat");
  assert.deepEqual(extractBlocks("```deckfill\n{\"edits\":[]}\n```").fills.length, 1);
  assert.deepEqual(normalizeFill({ edits: [] }), { title: undefined, edits: [] }, "no edits is still a deck: a template with its own codes needs none");
  assert.equal(normalizeFill({ title: "x" }), undefined, "but a block with no edit list at all isn't one");
});

test("with Google connected, the filled-in deck goes straight into the venture's Drive folder, with no .pptx in chat", async () => {
  const store = memoryStore(); await store.init();
  await setTemplate(store, "proedge", "Weekly Sales.pptx", await template());
  const provider = mockProvider("m");
  provider.run = async () => ({ text: '```deckfill\n{"title":"ProEdge weekly sales","edits":[{"slide":2,"find":"NSLI $1,900","replace":"NSLI $2,358"}]}\n```', provider: "m", modelId: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 });
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  const sent: { title: string; size: number; agent: string; folder: string }[] = [];
  jarvis.slidesExport = async (title, pptx, agentId, folder) => { sent.push({ title, size: pptx.length, agent: agentId, folder }); return "https://docs.google.com/presentation/d/abc123/edit"; };
  const { getAgent } = await import("../src/index.js");
  await jarvis.runAgent(getAgent("stevon")!, "Fill in the deck", { direct: true });
  assert.equal(sent[0]?.title, "ProEdge weekly sales");
  assert.ok(sent[0]!.size > 100);
  assert.equal(sent[0]!.folder, "ProEdge decks");
  const saved = (await store.chat.list(10)).find((m) => /Deck ready: ProEdge weekly sales · your template with 1 change\. Check before using it: [^\n]*\. Saved to your Google Drive in "ProEdge decks": https:\/\/docs\.google\.com\/presentation\/d\/abc123\/edit/.test(m.text));
  assert.ok(saved && !saved.files?.length, "no .pptx handed over when it's in Drive");
  // Drive refusing still hands over the .pptx and says why.
  jarvis.slidesExport = async () => { throw new Error("Google refused: reconnect Google"); };
  await jarvis.runAgent(getAgent("stevon")!, "Fill in the deck", { direct: true });
  assert.ok((await store.chat.list(10)).some((m) => /couldn't be saved to Google Drive: Google refused: reconnect Google; the \.pptx is attached instead/.test(m.text) && m.files?.length));
});

test("Drive gets a Google Slides conversion in a 'Jarvis decks' folder HQ made", async () => {
  const { GoogleConnector } = await import("../src/index.js");
  const store = memoryStore(); await store.init();
  const calls: { url: string; body: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString("latin1") : String(init?.body ?? "");
    calls.push({ url: u, body });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "x" });
    if (u.includes("/userinfo")) return json({ email: "phil@example.com" });
    if (u.includes("/drive/v3/files?q=")) return json({ files: [] });
    if (u.includes("/drive/v3/files?fields=id")) return json({ id: "folder1" });
    if (u.includes("/upload/drive/v3/files")) return json({ id: "slides9" });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  const g = new GoogleConnector(store, { clientId: "id", clientSecret: "s", redirectUri: "http://hq/cb", fetch: f });
  await g.exchangeCode("code");
  const id = await g.driveUpload("ProEdge weekly sales", Buffer.from("pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation", undefined, { folder: "Jarvis decks", convertTo: "application/vnd.google-apps.presentation" });
  assert.equal(id, "slides9");
  assert.match(decodeURIComponent(calls.find((c) => c.url.includes("/drive/v3/files?q="))!.url), /name = 'Jarvis decks'/);
  assert.match(calls.find((c) => c.url.includes("fields=id") && !c.url.includes("upload"))!.body, /"name":"Jarvis decks"/);
  assert.match(calls.find((c) => c.url.includes("/upload/"))!.body, /"parents":\["folder1"\],"mimeType":"application\/vnd\.google-apps\.presentation"/);
});

test("a .pptx Phil attached in chat can be made the template by the agent", async () => {
  const { readDocument, saveDoc } = await import("../src/index.js");
  const store = memoryStore(); await store.init();
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [mockProvider("m")], grok: [mockProvider("m")] } }) });
  const tool = jarvis.allTools().find((t) => t.name === "deck_template_from_chat")!;
  assert.match(await tool.handler({}, { store, agentId: "stevon" }), /hasn't attached a PowerPoint/);
  await saveDoc(store, await readDocument({ name: "ProEdge_Sales_Meeting.pptx", data: await template() }));
  const out = await tool.handler({}, { store, agentId: "stevon" });
  assert.match(out, /^ProEdge_Sales_Meeting\.pptx is now the template \(2 slides\)/);
  assert.equal((await getTemplate(store, "proedge"))?.name, "ProEdge_Sales_Meeting.pptx");
  assert.match(await tool.handler({ name: "budget" }, { store, agentId: "stevon" }), /No attached PowerPoint matches "budget"/);
});

/** A leaderboard like Phil's slides 10, 11 and 14: names and percentages repeat, so only position can tell rows apart. */
async function board(): Promise<Buffer> {
  const zip = new JSZip();
  const run = (t: string) => `<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r>`;
  const rows = [["Marino", "~24%"], ["Shehadeh", "~24%"], ["Marino", "~18%"]];
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("ppt/presentation.xml", '<p:presentation><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
  zip.file("ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p>${run("Close Rate Leaderboard")}</a:p><a:p></a:p></p:txBody></p:sp>${rows.map(([n, v]) => `<p:sp><p:txBody><a:p>${run(n!)}</a:p></p:txBody></p:sp><p:sp><p:txBody><a:p>${run(v!)}</a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("a leaderboard with repeated names and percentages is rewritten row by row, by paragraph number", async () => {
  const store = memoryStore(); await store.init();
  await setTemplate(store, "proedge", "Board.pptx", await board());
  const listing = await templateListing(store, "proedge");
  assert.match(listing, /Slide 1: \[1\] Close Rate Leaderboard  \[2\] Marino  \[3\] ~24%  \[4\] Shehadeh  \[5\] ~24%  \[6\] Marino  \[7\] ~18%/, "empty paragraphs aren't numbered");
  const spec = normalizeFill({ edits: [
    { slide: 1, para: 2, text: "Shehadeh" }, { slide: 1, para: 3, text: "50%" },
    { slide: 1, para: 4, text: "Marino" }, { slide: 1, para: 5, text: "38%" },
    { slide: 1, para: 6, text: "" }, { slide: 1, para: 7, text: "" },
    { slide: 1, para: 1, find: "Close Rate", replace: "Close-to-Issue" },
    { slide: 1, para: 3, find: "nope", replace: "x" },
    { slide: 1, para: 40, text: "x" },
  ] })!;
  assert.equal(spec.edits.length, 9);
  const { deck, missed, done } = await fillTemplate(store, spec, { agentId: "stevon", venture: "proedge" });
  assert.equal(done, 7);
  assert.deepEqual(missed.map((m) => m.para), [3, 40], "a check that fails, or a paragraph that isn't there, is reported");
  const out = await JSZip.loadAsync((await loadFile(deck.fileId))!.data);
  const texts = [...(await out.file("ppt/slides/slide1.xml")!.async("string")).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
  assert.deepEqual(texts, ["Close-to-Issue Leaderboard", "Shehadeh", "50%", "Marino", "38%", "", ""], "numbering is against the template as uploaded, so earlier edits never shift later ones");
});

test("normalizeFill keeps position edits and drops broken ones", () => {
  assert.equal(normalizeFill({ edits: [{ slide: 1, para: 0, text: "x" }, { slide: 1, para: 2 }, { slide: 1, para: 1.5, text: "x" }] }), undefined);
  assert.deepEqual(normalizeFill({ edits: [{ slide: 2, para: 3, replace: "x" }] })!.edits, [{ slide: 2, replace: "x", para: 3, text: "x" }], "\"replace\" alone with a para is read as its new text");
});

test("a deck with template numbers left over is checked before Phil sees it: the agent gets one pass to fix it, and Phil gets the fixed one", async () => {
  const store = memoryStore(); await store.init();
  await setTemplate(store, "proedge", "Weekly Sales.pptx", await template());
  const provider = mockProvider("m");
  const prompts: string[] = [];
  const first = { title: "ProEdge weekly sales", edits: [{ slide: 2, para: 1, text: "Close rate: 23.8%" }] };
  const fixed = { title: "ProEdge weekly sales", edits: [{ slide: 1, para: 2, text: "Week of {{week}}" }, { slide: 2, para: 1, text: "Close rate: {{close}}" }, { slide: 2, para: 2, text: "NSLI {{nsli}}" }, { slide: 2, para: 4, text: "{{rep:Marino.close}}" }] };
  const { saveSalesPull } = await import("../src/index.js");
  const row = (rep: string, issued: number, netIssued: number, demos: number, sold: number) => ({ rep, issued, netIssued, demos, sold, gross: sold * 26_000, cancels: 0, declines: 0, preCount: 0, pre: 0, net: sold * 20_000 });
  await saveSalesPull(store, { start: "11/09/2026", end: "11/15/2026", at: "x", team: row("Team", 101, 95, 69, 24), reps: [row("Marino, Phil", 10, 10, 8, 5), row("Shehadeh, Tarek", 20, 19, 15, 6)] });
  provider.run = async (req) => { prompts.push(req.prompt); const again = /HQ built your deck/.test(req.prompt); return { text: `${again ? "Fixed." : "Here's the deck: close 23.8%."}\n\n\`\`\`deckfill\n${JSON.stringify(again ? fixed : first)}\n\`\`\``, provider: "m", modelId: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 }; };
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  const { getAgent } = await import("../src/index.js");
  const r = await jarvis.runAgent(getAgent("stevon")!, "Fill in the deck", { direct: true });
  assert.equal(prompts.length, 2, "one correction pass, no more");
  assert.match(prompts[1]!, /3 paragraphs still carry the template's own numbers, unchanged: slide 1 \[2\] "Week of 11\/02 & 11\/08"/);
  assert.match(prompts[1]!, /The deck as it reads now:\nSlide 1: \[1\] ProEdge Weekly Sales  \[2\] Week of 11\/02 & 11\/08/);
  assert.match(prompts[1]!, /Here's the deck: close 23\.8%/, "his own numbers go back to him");
  const ready = (await store.chat.list(20)).filter((m) => /^Deck ready:/.test(m.text));
  assert.equal(ready.length, 1, "Phil gets one deck: the corrected one");
  assert.match(ready[0]!.text, /your template with 4 changes\.$/, "and it's clean");
  const { deckListing, deckFile, listDecks } = await import("../src/index.js");
  const built = await deckFile(store, (await listDecks(store, "proedge"))[0]!.id);
  assert.match(await deckListing(built!.data), /Slide 1: \[1\] ProEdge Weekly Sales  \[2\] Week of 11\/09–11\/15\nSlide 2: \[1\] Close rate: 25\.3%  \[2\] NSLI \$4,752  \[3\] Marino  \[4\] 50\.0%/, "HQ wrote the numbers: 24 ÷ 95 net issued; (24 × 20,000) ÷ 101");
  assert.match(r.text, /HQ checked the deck before it went to you and Stevon corrected it/);
  // Stevon can read the last deck back himself.
  const { SALES_TOOLS } = await import("../src/salesdata.js").then((m) => ({ SALES_TOOLS: Object.values(m).find((v) => Array.isArray(v) && (v as { name?: string }[]).some((t) => t?.name === "deck_last")) as { name: string; handler: (a: unknown, c: unknown) => Promise<string> }[] }));
  const out = await SALES_TOOLS.find((t) => t.name === "deck_last")!.handler({}, { store, agentId: "stevon" });
  assert.match(out, /Slide 1: \[1\] ProEdge Weekly Sales  \[2\] Week of 11\/09–11\/15/);
});

test("a slide with a chart is named: its numbers can't be changed by an edit", async () => {
  const store = memoryStore(); await store.init();
  const zip = await JSZip.loadAsync(await template());
  zip.file("ppt/slides/_rels/slide2.xml.rels", '<Relationships><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>');
  await setTemplate(store, "proedge", "Weekly Sales.pptx", await zip.generateAsync({ type: "nodebuffer" }));
  const f = await fillTemplate(store, { edits: [{ slide: 1, para: 2, text: "Week of 11/09 & 11/15" }, { slide: 2, para: 1, text: "Close rate: 23.8%" }, { slide: 2, para: 2, text: "NSLI $3,566" }, { slide: 2, para: 4, text: "50%" }] }, { agentId: "stevon", venture: "proedge" });
  assert.deepEqual(f.stale, []);
  assert.equal(f.typed.length, 3, "a $ or % typed by hand is flagged");
  assert.deepEqual(f.charts, [2]);
  const { fillProblems } = await import("../src/index.js");
  assert.match(fillProblems(f) ?? "", /slide 2 has a chart: HQ can't change a chart's numbers, so it still shows the template's$/);
});

test("only real figures count as stale: not row numbers or a year in a sentence; a target left as it was isn't typed", async () => {
  const { isFigure } = await import("../src/index.js");
  for (const t of ["1", "10", "3.", "Pre-1978 homes get the booklet", "Founded 2019"]) assert.equal(isFigure(t), false, t);
  for (const t of ["across 14 reps", "$640,747", "23.8%", "80%", "101 issued", "1,234"]) assert.equal(isFigure(t), true, t);
  const store = memoryStore(); await store.init();
  await setTemplate(store, "proedge", "Weekly Sales.pptx", await template());
  const f = await fillTemplate(store, { edits: [{ slide: 2, para: 4, text: "40%" }, { slide: 2, para: 2, text: "NSLI $2,000" }] }, { agentId: "stevon", venture: "proedge" });
  assert.deepEqual(f.typed.map((t) => t.text), ["NSLI $2,000"], "the 40% target kept as it was isn't flagged; a changed figure is");
});

test("a template that carries its own codes is filled by HQ with no edits at all, run by run, and says what it couldn't fill", async () => {
  const store = memoryStore(); await store.init();
  const zip = new JSZip();
  const run = (t: string, b = false) => `<a:r><a:rPr lang="en-US"${b ? ' b="1"' : ""}/><a:t>${t}</a:t></a:r>`;
  const sp = (paras: string[]) => `<p:sp><p:txBody>${paras.map((p) => `<a:p>${p}</a:p>`).join("")}</p:txBody></p:sp>`;
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("ppt/presentation.xml", '<p:presentation><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
  zip.file("ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree>${sp([run("Month to date: {{period}}"), run("Close rate: ", true) + run("{{close}}"), run("{{top.close.1.rep}}") , run("{{top.close.1|0}}"), run("{{clo") + run("se|0}} of {{net_issued}}"), run("{{rep:Nobody.close}}"), run("Takeaway goes here")])}</p:spTree></p:cSld></p:sld>`);
  await setTemplate(store, "proedge", "Coded.pptx", await zip.generateAsync({ type: "nodebuffer" }));
  const { saveSalesPull, deckListing, deckFile } = await import("../src/index.js");
  const row = (rep: string, issued: number, netIssued: number, demos: number, sold: number) => ({ rep, issued, netIssued, demos, sold, gross: sold * 25_000, cancels: 0, declines: 0, preCount: 0, pre: 0, net: 0 });
  await saveSalesPull(store, { start: "11/01/2026", end: "11/21/2026", at: "x", team: row("Team", 20, 16, 10, 4), reps: [row("Lane, Avery", 4, 4, 1, 1), row("Quill, Morgan", 16, 12, 9, 3)] });
  const f = await fillTemplate(store, { title: "ProEdge sales 11/01-11/21", edits: [{ slide: 1, para: 7, text: "Demos are the lever." }] }, { agentId: "stevon", venture: "proedge" });
  const text = await deckListing((await deckFile(store, f.deck.id))!.data);
  assert.equal(text, "Slide 1: [1] Month to date: 11/01–11/21  [2] Close rate: 25.0%  [3] Quill, Morgan  [4] 25%  [5] 25% of 16  [6] {{rep:Nobody.close}}  [7] Demos are the lever.");
  assert.equal(f.coded, 6, "six figures filled by HQ, one of them from a code PowerPoint had split in two");
  assert.equal(f.done, 1, "and the agent's one edit was words");
  assert.deepEqual(f.typed, []);
  assert.match(f.codeErrors.join(" "), /slide 1: \{\{rep:Nobody\.close\}\}: no rep "Nobody"/);
  // The bold label keeps its own run: only the figure's run changed.
  const xml = await (await JSZip.loadAsync((await deckFile(store, f.deck.id))!.data)).file("ppt/slides/slide1.xml")!.async("string");
  assert.match(xml, /<a:rPr lang="en-US" b="1"\/><a:t>Close rate: <\/a:t><\/a:r><a:r><a:rPr lang="en-US"\/><a:t>25\.0%<\/a:t>/);
});

test("bars are drawn from the numbers: a bar's width follows its figure, and the label sits at its end", async () => {
  const { scaleBars } = await import("../src/index.js");
  const row = (rep: string, issued: number, netIssued: number, demos: number, sold: number) => ({ rep, issued, netIssued, demos, sold, gross: 0, cancels: 0, declines: 0, preCount: 0, pre: 0, net: 0 });
  const week = { start: "11/01/2026", end: "11/21/2026", at: "x", team: row("Team", 100, 80, 40, 20), reps: [row("Lane, Avery", 10, 10, 8, 5), row("Quill, Morgan", 20, 20, 10, 5), row("Solo, Sam", 1, 1, 1, 1)] };
  const sp = (id: number, name: string, x: number, cx: number) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="5"/><a:ext cx="${cx}" cy="9"/></a:xfrm></p:spPr></p:sp>`;
  const xml = [
    sp(1, "hq:bar code=top3.close.1 of=top3.close.1 max=1000", 100, 777), sp(2, "hq:after code=top3.close.1 of=top3.close.1 max=1000 x0=100 gap=10", 999, 50),
    sp(3, "hq:bar code=top3.close.2 of=top3.close.1 max=1000", 100, 777), sp(4, "hq:after code=top3.close.2 of=top3.close.1 max=1000 x0=100 gap=10", 999, 50),
    sp(5, "hq:bar code=top3.close.3 of=top3.close.1 max=1000", 100, 777),
    sp(6, "hq:bar code=demos of=issued max=2000", 0, 5), sp(7, "hq:bar code=demo of=1 max=2000", 0, 5), sp(8, "Plain shape", 0, 5),
  ].join("");
  const out = scaleBars(xml, { week });
  const cx = (id: number) => Number(out.xml.match(new RegExp(`id="${id}"[\\s\\S]*?<a:ext cx="(\\d+)"`))![1]);
  const x = (id: number) => Number(out.xml.match(new RegExp(`id="${id}"[\\s\\S]*?<a:off x="(-?\\d+)"`))![1]);
  // Lane 5 of 10 = 50% heads the board (the one-lead rep at 100% isn't ranked: under 3 leads); Quill 5 of 20 = 25% is half as long.
  assert.deepEqual([cx(1), cx(3), cx(5)], [1000, 500, 0], "full width, half, and an empty third row");
  assert.deepEqual([x(2), x(4)], [1110, 610], "each label starts just past its bar");
  assert.equal(cx(6), 800, "a funnel bar: 40 demos of 100 issued");
  assert.equal(cx(7), 1000, "a rate out of 100%: 40 of 80");
  assert.equal(cx(8), 5, "any other shape is left alone");
  assert.equal(out.bars, 5);
});

test("the words a deck needs from the numbers: the period in full, when it was pulled, and up or down against the period before", async () => {
  const { fillNumbers } = await import("../src/index.js");
  const row = (demos: number) => ({ rep: "Team", issued: 100, netIssued: 100, demos, sold: 20, gross: 500_000, cancels: 0, declines: 0, preCount: 0, pre: 0, net: 0 });
  const week = { start: "11/01/2026", end: "11/21/2026", at: "2026-11-21T19:10:00Z", team: row(67), reps: [] };
  const f = (s: string, was: number) => fillNumbers(s, { week, prior: { ...week, start: "10/01/2026", end: "10/21/2026", team: row(was) } }).text;
  assert.equal(f("{{period_long}} · pulled {{pulled}} · {{prior.period}}", 78), "November 1 through 21 · pulled 11/21/2026 · 10/01–10/21");
  assert.equal(f("Demo rate {{trend.demo}} this period. {{Change.demo}} {{prior.demo|0}}.", 78), "Demo rate fell this period. Down from 78%.");
  assert.equal(f("Demo rate {{trend.demo}}; {{change.demo}} {{prior.demo|0}}", 60), "Demo rate rose; up from 60%");
  assert.equal(f("{{trend.demo}} / {{change.demo}}", 67), "held / level with");
  // Phil, Nov 27: slide 13's "per extra demo" is gross sold ÷ demos sat. No demos: no figure, never a divide by zero.
  assert.equal(f("+{{per_demo}} per extra demo ({{gross}} ÷ {{demos}}); was {{prior.per_demo}}", 50), "+$7,463 per extra demo ($500,000 ÷ 67); was $10,000");
  assert.doesNotMatch(f("{{prior.per_demo}}", 0), /NaN|Infinity/);
});

test("a template marked with codes isn't nagged about its plain text: a target and a rule's number are meant to stay", async () => {
  const store = memoryStore(); await store.init();
  const zip = new JSZip();
  const run = (t: string) => `<a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r>`;
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file("ppt/presentation.xml", '<p:presentation><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
  zip.file("ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p>${run("{{sold}} sales")}</a:p><a:p>${run("80%")}</a:p><a:p>${run("Reps with 3 or more leads issued")}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  await setTemplate(store, "proedge", "Coded.pptx", await zip.generateAsync({ type: "nodebuffer" }));
  const { saveSalesPull, fillProblems } = await import("../src/index.js");
  await saveSalesPull(store, { start: "11/01/2026", end: "11/21/2026", at: "x", team: { rep: "Team", issued: 9, netIssued: 9, demos: 5, sold: 2, gross: 1, cancels: 0, declines: 0, preCount: 0, pre: 0, net: 0 }, reps: [] });
  const f = await fillTemplate(store, { edits: [] }, { agentId: "stevon", venture: "proedge" });
  assert.deepEqual(f.stale, []);
  assert.equal(fillProblems(f), undefined, "a clean deck says nothing");
});
