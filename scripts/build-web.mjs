import { build } from "esbuild";

await build({
  entryPoints: ["apps/web/src/main.jsx"],
  bundle: true,
  outfile: "apps/web/dist/web.js",
  format: "esm",
  platform: "browser",
  sourcemap: true,
  target: ["chrome120"],
  loader: {
    ".css": "css",
  },
});
