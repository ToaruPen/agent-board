import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync(join(process.cwd(), ".canary-"));
const fakeKey = `${"ghp_"}${"A".repeat(36)}`;
try {
  writeFileSync(join(dir, "canary.txt"), `github_token = ${fakeKey}\n`);
  const result = spawnSync(
    "npx",
    ["secretlint", "--secretlintrc", ".secretlintrc.json", `${dir}/canary.txt`],
    { encoding: "utf8", shell: false },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0) {
    process.stderr.write("secretlint canary failed: planted dummy credential was not detected\n");
    process.exitCode = 1;
  } else if (!output.toLowerCase().includes("github")) {
    process.stderr.write(`secretlint canary failed with unexpected output\n${output}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("secretlint canary passed: planted dummy credential was rejected\n");
  }
} finally {
  rmSync(dir, { force: true, recursive: true });
}
