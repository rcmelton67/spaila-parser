import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

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

const version = Date.now().toString();
const indexPath = "apps/web/index.html";
let indexHtml = await readFile(indexPath, "utf8");
indexHtml = indexHtml
  .replace(/\.\/dist\/web\.css(?:\?v=\d+)?/g, `./dist/web.css?v=${version}`)
  .replace(/\.\/dist\/web\.js(?:\?v=\d+)?/g, `./dist/web.js?v=${version}`);
await writeFile(indexPath, indexHtml);
