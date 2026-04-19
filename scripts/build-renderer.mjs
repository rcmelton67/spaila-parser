import { build } from "esbuild";

await build({
  entryPoints: ["app/ui/index.jsx"],
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
