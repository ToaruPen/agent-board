# Sender

## Facts

- The hook entry point reads JSON on stdin, appends one line to a per session spool file, prints nothing, and exits 0 in every case.
- The daemon owns network delivery. It claims spool files by rename, retries with backoff, and dead letters poison lines.
- The daemon coalesces tool pulses. State changing events flush at once.
- The Windows transcript watcher is an isolated input source behind the interface in `transcript-watcher.ts`. Its failure must not affect the hook path.
- The stable hook command points at an installed shim path, not at a repo path. Codex pins hook trust to the command, so the command string should stay stable across updates.
