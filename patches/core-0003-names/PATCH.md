# core-0003-names: the built-in assistants say AionDX

**Target:** AionCore v0.2.2, `crates/aionui-app/assets/builtin-assistants` (embedded in `aioncore.exe`). **Status:** in installer 0.25.0.

The Butler and the other built-in assistants carry their display names, descriptions, prompts and rules in
`assistants.json` and `rules/*.md`. Where those said AionUi or AionUI they say AionDX now (40 files, 144 places). The
Moltbook assistant's files are left alone: its `AionUi-` prefix is a name registered on another service. Ids, skill
names, rule file names and avatar paths keep their lower-case `aionui-` form; they are keys.

`make-patch.js` regenerates `0001-names.patch` from the v0.2.2 tag in the reference clone (it never edits the clone):
it copies the originals into a throwaway repository, rewrites them, and takes the diff. `tools\build-aioncore.ps1
-Patched` applies every `patches\core-*\*.patch` to a clean checkout of the tag before building.

AionCore is built with the build folder, the cargo registry and the toolchain paths remapped
(`--remap-path-prefix`, and `/PDBALTPATH`), so the binary carries nothing about the machine that built it. Check any
build with `node tools\scan-binary.js <file>`.
