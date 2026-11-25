/**
 * The always-on half of the Jarvis glasses app. MentraOS runs this on Phil's phone (a bare JS engine, no screen) for as
 * long as the app is enabled, and hands it the session: the glasses' display, microphone and touch, and a channel to
 * the phone screen. Everything it does is in Controller; this file only plugs the real glasses into it.
 */
import { registerMiniapp } from "@mentra/miniapp/background";
import type { Channels } from "../shared/channels";
import type { Fetch } from "../shared/hq";
import { G2 } from "../shared/pages";
import { Controller, type Glass } from "./controller";

/** The line under the answer: the page count, or "…" while Jarvis is still working. */
const FOOTER_PX = 36;

registerMiniapp<Channels>(async (session) => {
  const size = () => {
    const d = session.capabilities?.display;
    const width = d?.width ?? d?.resolution?.width, height = d?.height ?? d?.resolution?.height;
    return width && height ? { width, height } : undefined;
  };
  const glass: Glass = {
    display: size,
    show(body, footer) {
      const { width, height } = size() ?? G2;
      void session.display.render([
        { type: "text", id: "body", box: { x: 0, y: 0, w: width, h: height - FOOTER_PX }, text: body, style: { breakMode: "word", overflow: "ellipsis" } },
        { type: "text", id: "footer", box: { x: 0, y: height - FOOTER_PX, w: width, h: FOOTER_PX }, text: footer, style: { maxLines: 1, overflow: "ellipsis" } },
      ]).catch(() => undefined);
    },
    clear() { void session.display.render([]).catch(() => undefined); },
    listen(on) { return session.transcription.on((d) => on({ text: d.text, isFinal: d.isFinal })); },
    // The all-day memory has its own listener: MentraOS hands each listener its own copy of what is heard.
    hearAll(on) { return session.transcription.on((d) => on({ text: d.text, isFinal: d.isFinal })); },
    // MentraOS's voice: the cloud one when connected, else the phone's own. Resolves when it finishes or is stopped.
    async say(text) { await session.speaker.speak(text, { stopOtherAudio: true }); },
    hush() { session.speaker.stop(); },
    store: { get: (k) => session.storage.get(k), set: (k, v) => session.storage.set(k, v) },
    notify(state) { if (session.ui.isOpen()) session.ui.send("state", state); },
    fetch: fetch as unknown as Fetch,
  };
  const jarvis = new Controller(glass);
  await jarvis.init();

  // The glasses (and the ring): hold to talk, tap for the next page, double tap to clear.
  session.input.onTouch((t) => jarvis.touch(t.kind));
  // Glasses with a button: a press starts a question.
  session.input.onButtonPress(() => jarvis.talk());

  // The phone screen: pairing, a test, and the same actions for when the glasses aren't on your face.
  session.ui.onOpen(() => session.ui.send("state", jarvis.state()));
  session.ui.on("save", ({ url, key }) => void jarvis.save(url, key));
  session.ui.on("test", () => void jarvis.test());
  session.ui.on("ask", ({ text }) => void jarvis.ask(text, false));
  session.ui.on("talk", () => jarvis.talk());
  session.ui.on("dismiss", () => jarvis.dismiss());
  session.ui.on("speak", ({ on }) => void jarvis.setSpeak(on));
  session.ui.on("cards", () => void jarvis.ask("what needs me", false));
});
