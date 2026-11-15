import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `importMetaUrl` is the process entry point.
 * Compares real filesystem paths, so it works on Windows where
 * `process.argv[1]` uses backslashes and a `file://` prefix string
 * comparison never matches.
 */
export function isMainModule(importMetaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return resolve(fileURLToPath(importMetaUrl)) === resolve(argv1);
  } catch {
    return false;
  }
}
