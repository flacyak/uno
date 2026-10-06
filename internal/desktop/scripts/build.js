// One production build: the messages, the renderer, then main and preload.
import { build } from "vite";
import { bundleElectron } from "./bundle.js";
import { compileMessages } from "./messages.js";

// Main and preload are bundled without the renderer's plugins, so the messages
// are compiled here, where every bundle that follows finds them.
await compileMessages();
await build({ configFile: "vite.config.ts", logLevel: "info" });
await bundleElectron();
console.log("built to out/");
