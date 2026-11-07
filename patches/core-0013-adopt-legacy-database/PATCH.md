# core-0013: an earlier version's database is renamed to the current name

Patch: `0001-adopt-legacy-database.patch` in this folder. Applies after core-0012, and before `tools\brand-names.js` renames AionUi to AionDX across the checkout (the build runs it right after the patches).
Target: AionCore v0.2.2 (tag `v0.2.2`, commit `47e66d0d`). Written November 1st, 2026.

## Why

The rename (R-082) changes the database file's name from `aionui-backend.db` to `aiondx-backend.db`. Without this patch an upgrade would open a new, empty database next to the old one and every chat would look gone.

## What it does

`AppConfig::database_path_in(data_dir)` (and `database_path()` through it) returns the current path, and before that, when only the earlier file exists, renames it and its `-wal` and `-shm` files to the current names. The three command-line tools that built the path themselves (`doctor`, `secret`, `user`) call it too. The earlier name is written in two lines marked `legacy-name`, which the rename script leaves as they are.

## Checked

- Two unit tests in `config.rs` (rename with the wal file; a current database is left alone when the old one is also there), run on the renamed tree.
- `tools\test-live-realdata.js`: the built app on a copy of a real 1.6 GB chats database, in a made-up APPDATA: the file is renamed, the migrations run, the conversation and message counts are identical (222 and about 428,000), no MCP server is duplicated for a user.
