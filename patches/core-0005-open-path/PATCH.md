# core-0005: Open a path the way a person clicking a link means it

Patch: `0001-open-path.patch` in this folder. Applies after core-0001 to core-0004.
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Written October 9th, 2026.

## Why

a request of October 9th, from a report of October 3rd. A link to a folder in the chat answered 400, because `POST /api/shell/open-file` only
accepts a file; an installer's chip showed "too big to preview" and did nothing; a path with a space or a "!" was the suspect.

## What it changes

A new route, `POST /api/shell/open-path` with `{ "path": "...", "action": "auto" | "open" | "reveal" | "run" }`:

- a folder opens in Explorer (`explorer.exe "<folder>"`, the argument text given to Explorer as it wants it);
- a program or installer (exe, msi, msix, bat, cmd, ps1, lnk, jar and similar) is shown selected in its folder
  (`explorer.exe /select,"<file>"`), and is started only with `action: "run"`;
- any other file opens in its own program; `reveal` shows any file selected in its folder;
- the path may use either slash, a `\?\` prefix (which Windows's canonical form carries and Explorer mishandles), a leading slash before the
  drive letter, quotes, spaces, "!" and any other character a Windows name can hold;
- the answer is `{ "did": "opened_folder" | "revealed" | "opened" | "ran" }`; a missing path answers 400 "file not found: <path>".

Code: `ShellService::open_path`, `clean_user_path`, `is_program_file` and the Explorer helpers (`aionui-shell/src/shell.rs`), the route in
`routes.rs`. Other platforms use `open`.

## Tests

`cargo test -p aionui-shell --lib open_path`: 2 passed (program extensions; path cleaning on Windows). The route is exercised by
`tools\test-live-oct9.js` (a missing path answers 400 with "not found").

## Not done

- A live click on a folder chip, an installer chip and a Run link is the owner's confirmation.
