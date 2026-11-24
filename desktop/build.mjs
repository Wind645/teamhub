import { build } from "esbuild";
import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { build as vite } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
process.chdir(root);
await Promise.all([
  build({
    entryPoints: { main: "src/main.ts", preload: "src/preload.ts", "pet-preload": "src/pet-preload.ts" },
    bundle: true, platform: "node", format: "cjs", target: "node24",
    outdir: "build", outExtension: { ".js": ".cjs" }, external: ["electron"],
  }),
  build({
    entryPoints: { worker: "src/worker.ts", hub: "../src/server.ts" },
    bundle: true, platform: "node", format: "cjs", target: "node24",
    outdir: "build/runtime", outExtension: { ".js": ".cjs" },
  }),
  build({
    entryPoints: { hook: "../src/hook.ts" },
    bundle: true, platform: "node", format: "esm", target: "node24",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    outdir: "build/runtime", outExtension: { ".js": ".mjs" },
  }),
  vite({ root: "ui", base: "./", build: {
    outDir: "../build/ui", emptyOutDir: true,
    rollupOptions: { input: [resolve("ui/index.html"), resolve("ui/pet.html")] },
  } }).then(() => cp("../桌宠", "build/ui/桌宠", { recursive: true })),
]);
