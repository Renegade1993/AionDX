# 0016-data-move: the installer moves an existing AionUi data folder to AionDX's, with every chat intact

Files: `aiondx-data-move.js` (shipped in `resources\aiondx\bin`, with `aiondx-data-move.cmd`), `test-data-move.js`. Run by `installer\aiondx.iss` (`MoveDataFolder`) after the files are copied. Written November 1st, 2026 (R-082).

## Why it is not a rename

Every conversation stores its working folder as an absolute path under `%APPDATA%\AionUi`, in the chats database (conversations, teams, folders, messages, mailbox, skills, assistants), and Claude Code keeps each chat's history in a folder named after that path. A link at the old name would keep both working, but junctions were measured not to work on this PC (a read through one fails with UNKNOWN), so the path is rewritten everywhere it is stored.

## What it does (nothing is changed unless every check passes)

0. Checks: the old folder is a real folder with a chats database that passes SQLite's own check; AionDX's folder has no chats; no program has the database open; disk space for a backup.
1. Backup of the database (`%LOCALAPPDATA%\AionDX\data-move\<stamp>\`), and the numbers a move must not change: rows in every table, and for every conversation whether its working folder exists.
2. The old folder is renamed to `AionDX` (one rename on the same volume). An empty start-up folder Chromium made there is cleared first.
3. Every text column has the old path rewritten in its three spellings (plain, JSON-escaped, forward-slash and `file:///`), each matched only with the separator that follows it, so a neighbour such as `AionUi.imported-...` is never touched; one transaction; anything left in another letter case is rewritten row by row.
4. Each Claude Code history folder named for an old path (in `~\.claude`, `~\.claude-*`, and any `CLAUDE_CONFIG_DIR` an agent uses; not `*imported*` copies) is renamed.
4b. Every other agent's history that names an old working folder follows it (`relocateAgents`). Searched: the home-folder data folders of agents named in the chats database's `agent_metadata` (command, name, backend) plus `%APPDATA%` and `%LOCALAPPDATA%` folders of the same names, and each Claude config folder (except its `projects` folder, handled in step 4). Text files (`.json`, `.jsonl`, `.md`, `.txt`, `.toml`, `.yaml` and similar, up to 100 MB) have the path rewritten in its three spellings; JSON must still parse afterwards; each file keeps its modified time and a copy in `%LOCALAPPDATA%\AionDX\data-move\<stamp>\agents\`. SQLite files that hold the path get the same rewrite as the chats database, after an integrity check, a `VACUUM INTO` backup, and a row-count check. Folders named by a working folder's path (Claude-style mangled, or the SHA-256, MD5 or SHA-1 of it, as Gemini does under `tmp`) are renamed to the new path's name. Bounded to 60 s per data folder and 240 s in all; cache, log and extension folders are skipped. A failure here undoes this step alone and the move stands; `aiondx-data-move.cmd agents` repeats it, and a second run finds nothing to change.
5. Small settings files that hold the path are rewritten, each with a `.before` copy.
6. Verification: integrity check, same rows in every table, no old path left in any spelling or case, every working folder exists exactly as before, every history folder is where it should be.

Every step is journaled (`journal.json`). Any failure undoes the steps already done, in reverse (the database from its backup). Exit codes: 0 moved, 3 nothing to do, 5 refused (nothing changed), 7 failed and undone, 8 failed and could not be fully undone. `aiondx-data-move.cmd rollback` undoes a finished move from its journal; `plan` prints what would change.

When the installer's step does not run or refuses (an agent left running holds a chat folder, AionDX or AionUi is open), nothing is changed and AionDX keeps using the AionUi folder where it is (patch 0015).

## Checked

- `node patches\0016-data-move\test-data-move.js`, 33 checks on made-up folders: plan changes nothing; the move (rows, every spelling, prose and unrelated paths untouched, neighbour folder untouched, history folders, settings file, backup and journal); a second run; rollback of a finished move; a failure injected after each step (folder, database, history, files) restores identical rows, paths and folders; refusals (AionDX has chats, a corrupt database, no old folder); a Chromium start-up folder in the way.
- `node tools\test-realdata-move.js --app`: a consistent copy of a real 1.6 GB chats database (222 conversations, about 429,000 messages, 458,000 rows in 33 tables), with a working folder and a Claude history folder made for each real conversation: plan 28 s, move 102 s, every table the same rows, 217 working-folder paths rewritten, 176 history folders renamed, nothing of the old path left, the built app then starts on the moved folder and loses no row in its own migrations, rollback in 1 s.
- `node tools\test-installer-migrate.js` (installer in a sandbox, `/DATAROOT` `/DATAHOME` `/DATALOCAL` `/NODE` pointing at made-up folders): the move through the installer, the install still succeeding with everything as it was when the move fails midway, and no earlier folder.

Step 4b is covered by `test-data-move.js` (45 checks now): Gemini JSON and a hashed folder, Cursor's mangled folder, Codex sessions, Devin notes and database, OpenCode state, Claude's `.claude.json` and `history.jsonl` are rewritten or renamed; an editor's and a chat program's files that merely sit in the home folder are left alone; a failure injected after the step leaves every agent's files as they were while the move stands; `agents` redoes it and is idempotent; a locked file is skipped with a note.

Not covered: no real session of each agent was resumed after a move (the test machine's Gemini, Antigravity and Devin data were surveyed and matched the fixtures: path in 8 JSON files under `~\.gemini`, 8 notes and 1 database under `%APPDATA%\Devin`). An agent whose history is stored in a format other than text or SQLite, or in a place the chats database does not name, keeps the old path and starts that conversation's agent history fresh in the new working folder.

## November 12th, 2026: any folder, another drive, portable (R-102)

- `--from DIR --to DIR`: any data folder to any other. A target must be empty (or new) and not inside the source or around it.
- Another drive: the folder is copied, then the old one is renamed `<name>.moved-<time>` and kept; a failure removes the copy and puts the
  old name back.
- `--portable`: after verification, `aiondx-portable.json` in the new folder, `AionDX-drive.json` at its drive's root, and this PC's pointer.
- `aiondx-portable-move.js`: run by AionDX's "Move my chats to a drive" (patch 0009): waits for AionDX and its backend to close (2 minutes at
  most), runs the move, writes `%LOCALAPPDATA%\AionDX\data-move\portable-last.json`, opens AionDX again. Hard deadline 2 hours.
- Tests: `test-data-move.js` 51 (six on H:), `test-portable-move.js` 6 (end to end on H:).
- The mover takes `--pointer`, `--local`, `--home`, `--roaming` (it runs with the user's own environment when AionDX starts it through WMI),
  and `--skip-process-check` / `--no-reopen` for tests. The run's folder name is unique per run (two moves in one second met each other's
  backup file). `tools\test-live-drive.js`: the built app moves itself to a second drive through its own bridge and opens again from it (9).
