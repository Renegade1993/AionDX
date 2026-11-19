# core-0023: a local attachment may be a folder; the CLI reads JSON piped from Windows PowerShell (November 19th, 2026)

Patch: `0001-local-folders-and-stdin.patch`. Applies after core-0022, before `tools\brand-names.js`. Target: AionCore v0.2.2.
Work on it: `.tmp\core-base23.ps1`, then `git add -N crates/aionui-app/src/commands/stdin_text.rs` and
`git diff HEAD --output=patches\core-0023-local-folders-and-stdin\0001-local-folders-and-stdin.patch`.

## A folder dropped into the message box

The user asked, November 17th, 2026, that a folder dragged into the message box go in as a link and look the same as a dropped picture;
AionDX's page script sends a dropped folder as a `local` attachment with its path (as it does a file of 29 MB or more). Upstream
accepts a `local` attachment only when it is a regular file (`chat_files.rs`), though a `project` attachment may already name a folder.
This lets a `local` one be a folder too; the message gets its path after the files marker, as for a file, and the agent reads it with its
own tools. Test: `local_directory_resolves_to_its_path` (was `local_directory_is_rejected`).

## JSON on stdin from Windows PowerShell 5.1

Measured on the development PC: `'{...}' | program` in Windows PowerShell 5.1 sends `EF BB BF` before the JSON, and twice when
`$OutputEncoding` is `[Text.Encoding]::UTF8`; setting it to UTF-8 without a mark does not stop it. serde_json refuses a leading mark, so
every `aioncore` command that takes JSON on stdin (`config`, `diagnose`, `conversation`, `session`, `skills`, `team`) failed with
"invalid JSON payload on stdin" for agents on a PC without Git Bash (they run commands in PowerShell). Found by an agent on the second PC
(the laptop diagnosis package, G3). New `commands\stdin_text.rs` reads the bytes, decodes UTF-16 when it starts with its mark, and drops
every leading mark; the six readers use it. Tests in that module.
