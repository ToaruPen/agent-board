import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/ui/board.ts"],
  format: "esm",
  outfile: "public/app.js",
  platform: "browser",
  target: "es2022",
});
