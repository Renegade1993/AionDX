AionDX profile package
======================

A copy of an AionDX setup (AionDX, its teams and chats, the Claude Code accounts, settings, tools) with what is needed to put it on
another PC and to bring it back again. Made with tools\profile-move\make-package.ps1 in the AionDX project.

  install.bat   on the PC that should GET the setup
  export.bat    on the PC that HAS the setup, to bring this folder up to date with it (only what changed is copied)

Both write a full log into the logs folder. Both can be run again; nothing is ever deleted.

The round trip
  1. This PC, before leaving:   export.bat
  2. Copy this folder to an external drive or the other PC.
  3. Other PC:                  install.bat
  4. Work there.
  5. Other PC, at the end:      export.bat               (this folder now carries that PC's setup)
  6. This PC again:             install.bat              (close AionDX and Claude Code first; it offers to close them)

Any Windows account works. install.bat reads the account it runs under and rewrites every stored path that pointed into the
other PC's user folder (settings files, the AionDX database, Claude Code's folders and transcripts, the account router).
To see what it would do without changing anything:   install.bat -DryRun

What install.bat does, in order
  1. Checks free disk space and that AionDX and Claude Code are closed (offers to close them).
  2. Installs what is missing from redist\, each file's signature checked first. Windows asks for permission once.
       Visual C++ 2015-2022 runtime (x64), Git for Windows, Node.js, Python
  3. Installs AionDX from installers\ (checked against SHA256SUMS.txt), unless the same or a newer AionDX is already there.
  4. Restores data\. A folder that already exists is renamed "<name>.pre-restore-<time>" beside the new one. Claude Code
     transcripts that only the old folder had are moved into the restored one, so no history is lost either way.
  5. Rewrites the stored paths for this account (tools\rehome.js).
  6. Recreates the links between profile folders, sets the Windows user variables that were exported (a long-lived Claude
     sign-in among them, if there is one) and adds the PATH entries (AionDX's bin, npm, Claude Code).
  7. Reports each Claude Code account named by AionDX's account router, offline (the sign-ins are not used).
  8. Offers to start AionDX.
Switches: -Yes (no questions), -SkipRedist, -SkipApp, -SkipData, -DryRun, -TestRoot <folder> (a rehearsal into a folder).

What is in data\ (MANIFEST.json lists every folder, its file count and size)
  roaming-AionUi     AionDX's data: the database (teams, chats, agents, assistants, settings, MCP servers, scheduled tasks),
                     chat working folders, sign-in state
  local-AionDX       the aiondx command line tools and AionDX's user settings
  home-aiondx        .aiondx (AIONDX.md, MCP list, skills)
  home-agents        .agents (the agent registry, ACP tooling, skills)
  npm-global         the Claude Code command, the account router and the agent connectors (%APPDATA%\npm)
  home-local-bin     Claude Code's own install (.local\bin)
  claude, claude-<name>, claude-<name>-home
                     the Claude Code config folders found in the user folder: settings, CLAUDE.md, memory, skills, plugins,
                     sign-ins, tools, transcripts
  home.gemini, home.windsurf, home.cursor, home-files (.claude.json, .gitconfig)
  MANIFEST.json also holds the Windows user variables and PATH entries that are carried over.

Claude Code transcripts are copied newest first up to 5 GB; anything older is listed in MANIFEST.json (conversationCache).

Not in the package, on purpose
  Logs, browser and GPU caches, crash dumps, old database backups, Claude Code's cached older versions, Claude Desktop's own data,
  SSH keys, Devin, the web UI's sign-in cookie (always locked while AionDX runs: the web UI asks for a sign-in once), and project
  folders outside the user folder (the AionDX database shows which teams and chats use one; copy those folders to the same path).

Things to know
  - This folder contains sign-in tokens and keys. Treat it like a password manager: keep it off shared drives, and never put it in
    a repository.
  - The two PCs share the same Claude sign-ins. Long-lived tokens (claude setup-token) work on both at once. A sign-in that renews
    itself can sign the other PC out when one of them renews it: then run   claude /login   there.
  - Do not run install.bat on the PC the package was just exported from: it would put this snapshot over the live setup (the old
    folders are kept as .pre-restore, but AionDX would start from the snapshot).
  - An agent on the other PC can finish anything that did not go through: see AGENT-GUIDE.md.
