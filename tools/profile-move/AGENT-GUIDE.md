# For an agent helping with an AionDX profile package

The package folder moves a whole AionDX setup between PCs. The user runs `install.bat` (to receive it) or `export.bat` (to capture this PC into it). Both write a log to `logs\`. Read the newest log first; its last lines list anything that needs a look.

## Priority: the Claude Code accounts

If the Claude Code accounts work, the user can fix everything else with an agent. Check them first.

- Config folders: `%USERPROFILE%\.claude` and any `%USERPROFILE%\.claude-<name>`. A `.claude-<name>-home` folder is a whole home for one account: a folder of links whose `.claude` points at `.claude-<name>`.
- What signs an account in: a long-lived token file named by AionDX's account router, or the folder's `.credentials.json`. `install.ps1` reports each router account at the end of its log, offline.
- The router: `%APPDATA%\npm\claude-account-router.config.json` (`accounts.<id>.configDir`, `tokenFile`, `defaultAccount`). Its paths must point into this PC's user folder.
- A long-lived sign-in may also be in the Windows user variable `CLAUDE_CODE_OAUTH_TOKEN` (set by install.ps1 when it was exported).
- Test cheaply: `claude --version`, then `claude -p "reply with ok"` once per config folder (`CLAUDE_CONFIG_DIR` set to it). If one is signed out, the user runs `claude /login` for it.

## If something did not go through

- Paths still pointing at the other PC's user folder: `node tools\rehome.js --from "<old user folder>" --to "%USERPROFILE%" --root <folder> --db "%APPDATA%\AionUi\aionui\aionui-backend.db"` (`--dry` first). The old user folder is `home` in `MANIFEST.json`. Use AionDX's own Node (`%LOCALAPPDATA%\Programs\AionDX\resources\bundled-aioncore\win32-x64\managed-resources\node\...\node.exe`) or any Node 22.13+.
- A folder that was in use and was laid over instead of replaced: the log says which. Close what uses it and run `install.bat -SkipRedist -SkipApp` again.
- A redistributable that failed: install it by hand from `redist\`.
- `.pre-restore-<time>` folders are what was there before; once everything works they can be deleted (ask the user).
- Project folders outside the user folder are not in the package; teams and chats that use them need the user to copy those folders to the same path.

## Going back

On this PC at the end: `export.bat` (only what changed is copied; AionDX can stay open, its database is copied as one snapshot). Then the user takes the folder home and runs `install.bat` there.

## Files

- `install.bat` / `install.ps1`: restore. `export.bat` / `tools\refresh-package.ps1`: capture. `tools\export.js`: the copier. `tools\rehome.js`: the path rewriter.
- `MANIFEST.json`: what the export contains, where each part goes (`{HOME}`, `{APPDATA}`, `{LOCALAPPDATA}` stand for this PC's folders), the user variables and PATH entries, and the old user folder.
