import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/sender/hook.ts"],
  format: "esm",
  outfile: "dist/hook.bundle.mjs",
  platform: "node",
  target: "node22",
});
