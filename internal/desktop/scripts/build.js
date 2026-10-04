// Production build: the messages, the renderer, then main, preload and the
// engine.
import { build } from "vite";
import { bundleElectron } from "./bundle.js";
import { compileMessages } from "./messages.js";

// The messages are compiled first. Every bundle below imports them.
await compileMessages();
await build({ configFile: "vite.config.ts", logLevel: "info" });
await bundleElectron();
console.log("built to out/");
