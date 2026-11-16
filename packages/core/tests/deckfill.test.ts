import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
process.env.JARVIS_UPLOAD_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-deckfill-"));
const { memoryStore, Jarvis, ModelRouter, mockProvider, setTemplate, getTemplate, templateText, fillTemplate, normalizeFill, loadFile, deckFile } = await import("../src/index.js");
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
  const msg = chat.find((m) => /Deck ready: ProEdge weekly sales · your template with 1 change\. 1 change didn't match the template's text and weren't made: slide 2 "Nope"/.test(m.text));
  assert.ok(msg?.files?.length, "the file is handed over in chat");
  assert.deepEqual(extractBlocks("```deckfill\n{\"edits\":[]}\n```").fills.length, 1);
  assert.equal(normalizeFill({ edits: [] }), undefined);
});

test("with Google connected, the filled-in deck also comes back as a Google Slides link", async () => {
  const store = memoryStore(); await store.init();
  await setTemplate(store, "proedge", "Weekly Sales.pptx", await template());
  const provider = mockProvider("m");
  provider.run = async () => ({ text: '```deckfill\n{"title":"ProEdge weekly sales","edits":[{"slide":2,"find":"NSLI $1,900","replace":"NSLI $2,358"}]}\n```', provider: "m", modelId: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, durationMs: 1 });
  const jarvis = new Jarvis({ store, router: new ModelRouter({ store, providers: { claude: [provider], grok: [provider] } }) });
  const sent: { title: string; size: number; agent: string }[] = [];
  jarvis.slidesExport = async (title, pptx, agentId) => { sent.push({ title, size: pptx.length, agent: agentId }); return "https://docs.google.com/presentation/d/abc123/edit"; };
  const { getAgent } = await import("../src/index.js");
  await jarvis.runAgent(getAgent("stevon")!, "Fill in the deck", { direct: true });
  assert.equal(sent[0]?.title, "ProEdge weekly sales");
  assert.ok(sent[0]!.size > 100);
  assert.ok((await store.chat.list(10)).some((m) => /Deck ready: ProEdge weekly sales · your template with 1 change\. Google Slides: https:\/\/docs\.google\.com\/presentation\/d\/abc123\/edit/.test(m.text)));
  // Drive refusing still hands over the .pptx and says why.
  jarvis.slidesExport = async () => { throw new Error("Google refused: reconnect Google"); };
  await jarvis.runAgent(getAgent("stevon")!, "Fill in the deck", { direct: true });
  assert.ok((await store.chat.list(10)).some((m) => /couldn't be put in Google Slides: Google refused: reconnect Google; the \.pptx is attached/.test(m.text) && m.files?.length));
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
