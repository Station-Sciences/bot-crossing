# Fork divergences

This fork keeps upstream's policies except for three narrowly-scoped Cursor integration choices.

1. **A `~/.cursor/bot-crossing-open.json` IPC request is written on Open.** This touches
   DECISIONS.md's “Bot Crossing never writes to a harness” rule and the harness README's
   read-only rule. We accept it because Cursor has no local-thread deep link and
   `composer.focusComposer` is the only known way to focus a specific composer. The file is not a
   Cursor session record: it is mode `0600`, contains only a composer id, workspace, request id and
   timestamp, expires after 30 seconds, is deduplicated, and is consumed by the helper.
2. **Opening a Cursor thread may auto-install the helper extension with the user's `cursor` CLI.**
   This touches the same no-writes rule because it changes the user's extension installation. We
   accept it so per-thread Open works without a manual packaging step. It happens only after an
   explicit Open action, uses a CLI found on PATH or in `~/.cursor/bin`, and never references or
   executes an application-bundle path. If no CLI is available, workspace opening still works and
   the diagnostic gives manual-install guidance.
3. **The live global `state.vscdb` is read.** This departs from upstream cursor.mjs's explicit
   decision to omit the multi-gigabyte database held open by Cursor. We accept a read-only query
   because it is the only source for composer/sidebar titles and state. The query excludes large
   subagent values in SQL, is cached by database mtime and size, closes every connection, and keeps
   a last-good snapshot across transient locks; transcripts remain available when SQLite fails.

The helper-extension approach is **not upstreamable as-is** because its IPC write and extension
installation intentionally conflict with upstream's one-writer/read-only harness policy.
