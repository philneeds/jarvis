/**
 * The phone screen of the Jarvis glasses app: pair with HQ, test the link, and ask without the glasses on. It has no
 * access to the glasses or the network itself; everything goes to the always-on half through the `mentra` bridge that
 * MentraOS puts on the page.
 */
import type { MentraTyped } from "@mentra/miniapp/ui";
import type { AppState, Channels } from "../shared/channels";

declare const mentra: MentraTyped<Channels>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status"), you = $("you"), reply = $("reply");
const url = $<HTMLInputElement>("url"), key = $<HTMLInputElement>("key"), question = $<HTMLInputElement>("question");
const talk = $<HTMLButtonElement>("talk");

function show(s: AppState) {
  status.textContent = s.status;
  status.classList.toggle("bad", /^(Not saved|can't reach|HQ )/i.test(s.status));
  you.textContent = s.you ? `You: ${s.you}` : "";
  reply.textContent = s.reply;
  if (s.url && document.activeElement !== url) url.value = s.url;
  key.placeholder = s.paired ? "saved (enter a new one to replace it)" : "from HQ › Settings › Glasses";
  talk.textContent = s.phase === "listening" ? "Listening… (tap to stop)" : "Talk through the glasses";
}

mentra.on("state", show);
$("pair").addEventListener("submit", (e) => { e.preventDefault(); mentra.send("save", { url: url.value, key: key.value }); key.value = ""; });
$("test").addEventListener("click", () => mentra.send("test", {}));
$("ask").addEventListener("submit", (e) => { e.preventDefault(); const text = question.value.trim(); if (text) { mentra.send("ask", { text }); question.value = ""; } });
talk.addEventListener("click", () => mentra.send("talk", {}));
$("dismiss").addEventListener("click", () => mentra.send("dismiss", {}));

// Tells MentraOS the screen is up, so the always-on half's first "state" gets through.
mentra.ready();
