
# 0015-data-folder

`apply.js` puts two blocks at the top of the main process (run by `tools\build-release.ps1` after `tools\brand-names.js`).

1. `aiondxPortableDrive` (R-102, November 12th, 2026): before anything opens the data folder, AionDX uses a folder on an AionDX drive: this PC's
   pointer (`%APPDATA%\AionDX-location.json`) when its folder is there, else any drive root's `AionDX-drive.json` naming a marked folder, but only
   at the letter the drive was made with (every chat stores full paths). A PC that has not used the drive takes it up and writes the pointer.
   `global.__aiondxPortable` tells the page: using, other-letter, missing, none. `test-portable-start.js` 7.
2. `aiondxDataFolder` (November 1st, 2026): an earlier version's `%APPDATA%\AionUi` is used in place when AionDX's own folder has no chats.
