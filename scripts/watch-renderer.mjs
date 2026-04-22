import { context } from "esbuild";

const ctx = await context({
  entryPoints: ["app/ui/src/index.jsx"],
  bundle: true,
  outfile: "app/ui/dist/renderer.js",
  format: "iife",
  platform: "browser",
  sourcemap: true,
  target: ["chrome120"],
  loader: {
    ".css": "css",
  },
});

await ctx.watch();
console.log("[RENDERER] Watching for changes…");
