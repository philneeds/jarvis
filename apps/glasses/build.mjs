// Builds the two halves a MentraOS miniapp ships, in the layout `mentra-miniapp pack` and `release` expect:
//   dist/background/index.js   the always-on half (a bare JS engine on the phone: no DOM, no modules, so one IIFE file)
//   dist/ui/index.html + js    the phone screen (a WebView)
// plus miniapp.json and icon.png beside them.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/ui", { recursive: true });
await build({ entryPoints: ["src/background/index.ts"], outfile: "dist/background/index.js", bundle: true, format: "iife", platform: "browser", target: "es2020", logLevel: "warning" });
await build({ entryPoints: ["src/ui/main.ts"], outfile: "dist/ui/main.js", bundle: true, format: "iife", platform: "browser", target: "es2020", minify: true, logLevel: "warning" });
await cp("src/ui/index.html", "dist/ui/index.html");
await cp("src/ui/styles.css", "dist/ui/styles.css");
await cp("miniapp.json", "dist/miniapp.json");
await cp("icon.png", "dist/icon.png");
console.log("built dist/ (background + ui)");
