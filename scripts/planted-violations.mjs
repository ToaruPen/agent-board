import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync(join(process.cwd(), ".violations-"));

function run(args) {
  const outcome = spawnSync("npx", args, { encoding: "utf8" });
  return { output: `${outcome.stdout ?? ""}${outcome.stderr ?? ""}`, status: outcome.status ?? 1 };
}

function expectFailure(name, args, needle) {
  const outcome = run(args);
  if (outcome.status === 0) throw new Error(`${name} violation was not detected`);
  if (needle && !outcome.output.toLowerCase().includes(needle.toLowerCase())) {
    throw new Error(`${name} failed without the expected marker\n${outcome.output}`);
  }
  process.stdout.write(`${name}: failed as designed (exit ${outcome.status})\n`);
}

try {
  const fakeToken = `${"ghp_"}${"B".repeat(36)}`;
  writeFileSync(join(dir, "secret.txt"), `github_token = ${fakeToken}\n`);
  expectFailure(
    "fake secret",
    ["secretlint", "--secretlintrc", ".secretlintrc.json", join(dir, "secret.txt")],
    "github",
  );

  writeFileSync(join(dir, "bad.ts"), "export const x = value as any;\n");
  expectFailure(
    "ast-grep pattern",
    ["ast-grep", "scan", "--rule", "rules/no-as-any.yml", join(dir, "bad.ts")],
    "no-as-any",
  );

  writeFileSync(join(dir, "format.ts"), "export const x={a:1,b:2};\n");
  expectFailure("format", ["biome", "format", join(dir, "format.ts")], "format");
  process.stdout.write("planted violations passed: all three checks fail on planted input\n");
} finally {
  rmSync(dir, { force: true, recursive: true });
}
