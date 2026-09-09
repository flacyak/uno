// One production build: renderer, then main and preload.
import { build } from "vite";
import { bundleElectron } from "./bundle.js";

await build({ configFile: "vite.config.ts", logLevel: "info" });
await bundleElectron();
console.log("built to out/");
