#!/usr/bin/env node
/**
 * brand-exe.mjs - gives the standalone AionDX's main program the AionDX identity.
 *
 *   node tools\brand-exe.mjs <AionDX.exe> <aiondx.ico> <AionDX version>
 *
 * The standalone build (tools\build-release.ps1) ships AionUi 2.2.2's own AionUi.exe, renamed
 * AionDX.exe. This replaces its icon (every icon group, so Explorer, the taskbar, Task Manager and
 * Alt-Tab show the AionDX mark) and the version strings Windows shows (FileDescription, ProductName,
 * CompanyName, OriginalFilename, ProductVersion). Nothing else in the file changes: the Electron fuse
 * wire and the Integrity/ElectronAsar resource are left as they are (the integrity fuse is off in
 * AionUi 2.2.2, which is why a patched app.asar loads at all). The file is unsigned before and after.
 *
 * Uses resedit (pure JavaScript, vendor\node_modules). Exit 0 on success.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const vendor = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
const require = createRequire(path.join(vendor, 'package.json'));
const ResEdit = await import(pathToFileURL(require.resolve('resedit')).href);

const [exePath, icoPath, version] = process.argv.slice(2);
if (!exePath || !icoPath || !version) { console.error('usage: node brand-exe.mjs <exe> <ico> <version>'); process.exit(2); }

const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);

// The icon: every icon group gets the AionDX .ico (AionUi.exe has one group; replace whatever is there).
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
if (!groups.length) { console.error('no icon group in ' + exePath); process.exit(1); }
for (const g of groups) {
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, ico.icons.map((i) => i.data));
}

// The version strings.
const vis = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (!vis.length) { console.error('no version resource in ' + exePath); process.exit(1); }
const vi = vis[0];
const lang = vi.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
vi.setStringValues(lang, {
  FileDescription: 'AionDX',
  ProductName: 'AionDX',
  CompanyName: 'AionDX',
  OriginalFilename: 'AionDX.exe',
  InternalName: 'AionDX',
  ProductVersion: version,
  Comments: 'AionDX ' + version + ': AionUi 2.2.2 with the AionDX patches. AionUi is Apache-2.0 software by iOfficeAI.',
});
vi.outputToResourceEntries(res.entries);

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`branded ${exePath}: ${groups.length} icon group(s), version strings AionDX ${version}`);
