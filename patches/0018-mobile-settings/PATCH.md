# 0018-mobile-settings: Settings > Mobile, the PC side of the AionDX phone app

**Target:** renderer only (two plain scripts, like patches 0001 and 0011) · **Needs:** an AionCore with core-0015's admin routes
(`/api/mobile/admin/*`) · **Spec:** `docs/mobile-bridge/DESKTOP-UI-SPEC.md`; behaviour from `CONTRACT.md` §3 (pairing, SAS,
devices) and §5.3 (re-key) · **Status:** written 2026-11-08, tested live against a bridge-capable core (below), not yet in a
release build.

## What it adds

- A **Mobile** item in the settings sidebar, after Remote, and a **Mobile** card at the top of Settings > Remote
  (`#/settings/webui`), above the WebUI/Channels tabs. The sidebar item opens that page and scrolls to the card. A route of its
  own (`#/settings/mobile`) would mean patching the router inside the hashed bundle; this needs no anchor in it.
- **Phone access** switch (`PUT /api/mobile/admin/settings {enabled}`, off by default), the port it listens on, the addresses
  phones can use, and the bridge's `error` in red ("Mobile access is unavailable this session: ...").
- The **recovery notice** (`lastRecovery`): yellow, the spec's wording for `database` and `host_key`, `movedTo` as a detail,
  Dismiss (`POST recovery/dismiss`).
- **Pair a phone** (enabled only while listening): a QR of the offer's `aiondx://pair` URI with a countdown to `expiresAt`; the
  offer is polled every second; on `request_received` the QR gives way to the phone's name and platform and the **SAS, large**,
  with "The codes match" (`approve {sasConfirmed: true}`) and "They don't match" (`reject`). `approved` closes it and refreshes
  the list; `rejected`/`aborted`/`expired` show a message and "Try again". Closing the dialog while waiting rejects the offer.
- **Paired phones**: name (edit in place, Enter or leaving the field saves, Escape cancels), platform, app version, paired date,
  last seen (relative) and from where, a green dot while `activeSessions > 0`; "Confirm sensitive actions on the phone"
  (`PATCH {requireConfirm}`); **Reset confirmation key** (a QR of the `aiondx://rekey` URI, no SAS step, the list polled while
  it shows); **Revoke** after a confirm dialog (`DELETE`).
- **Advanced** (collapsed): port, PC name (shown on the phone), extra addresses (one per line), mDNS, "Allow phones to edit
  tasks". The switches save at once; the text fields with Save.
- **Windows Firewall** row, shown only when `GET /api/mobile/admin/firewall` answers (phase 5; a 404 hides it): the rule's state;
  when it is absent, "Allow phones through Windows Firewall (Private networks only)"; when present, "Remove the rule". Only on
  the user's click, through `window.aiondxMobile` (below); the page gets `{ok, error}` back and shows the error in plain words.
  On a build without that handler, the button shows the exact command to run in an administrator prompt instead.

## The firewall path in the main process (`apply.js`, `firewall-plan.js`)

The page never chooses what gets elevated. `apply.js` adds to `out/main/index.js` one IPC handler, `aiondx:mobile-firewall`
(action `allow` or `remove`; for `allow` the port, which must be a whole number from 1024 to 65535), and to
`out/preload/index.js` `window.aiondxMobile = { allowFirewall(port), removeFirewall() }`, which only invoke that handler.
Main builds the plan itself (`firewall-plan.js`, inlined; the same rules as core-0015's `firewall.rs`): `%SystemRoot%\System32\
netsh.exe` by absolute path, the fixed rule name `AionDX mobile bridge`, `dir=in action=allow protocol=TCP localport=<port>
profile=private program=<the app's own resources\bundled-aioncore\win32-x64\aioncore.exe> enable=yes`; a program path with a `"`,
`=`, a control character, a relative path or a trailing separator is refused, never quoted around. It runs that through the app's
own `resources\elevate.exe -wait` (`ShellExecuteEx`, a UAC prompt), as an argument vector with no shell, then reads the rule back
with the read-only `netsh ... show rule ... verbose` and answers `{ok: true}` only if the rule is there, enabled, Private-only
and on that port (for `remove`, only if it is gone); a cancelled prompt answers `{ok: false, error}` in plain words. One request
at a time; nothing off Windows. `apply.js` runs after patch 0010 (they edit the same preload line, which both keep); re-running
it replaces its marked main block and leaves the preload alone; a missing anchor writes nothing.

Polling: status and the device list every 2 s, the firewall every 10 s, only while the card is on screen and the window is
visible; an open offer every second. Everything a phone sent (its name, platform) is put on the page as text, never as HTML.
Styling uses the app's Arco classes and theme colours; the QR is drawn black on white in every theme, as a scanner needs.

`qrcodegen.js` is Project Nayuki's QR Code generator (MIT), vendored unchanged from the `qrcode.react` 4.2.0 the app already
ships (`node_modules/qrcode.react/lib/index.js`, lines 66-791), with its licence header, wrapped to set
`window.AionDxQrcodegen`. A 226-character pairing URI encodes as version 11 at error-correction level M.

## Installing, checking, removing

Wired into `tools\build-release.ps1` like 0011: two script tags after 0001's `aiondx-ui.js` tag in `index.html` (the QR library
first), a `Copy-Item` of each file to `out\renderer\` (`aiondx-qrcodegen.js`, `aiondx-mobile-settings.js`), both in the
renderer privacy check, a README line, and `0018-mobile-settings` in the release manifest's patch list. Removing: those lines and
the two files; the bridge's own settings stay where AionCore keeps them.

Check `test-firewall.js` (51 checks, nothing real run): the plan builder against firewall.rs's injection cases (a quote closing
netsh's quoting, `=`, newline, NUL, relative and folder paths, ports outside 1024-65535 or not integers, unknown actions); the
show-rule parser; `apply.js` on a made-up tree (idempotent, a missing anchor writes nothing, the preload exposes exactly two
calls on one channel); and the inserted main block run in a sandbox whose `spawn` only records - allow runs exactly `elevate.exe
-wait netsh.exe <12 args>` then the read-only show rule; extra arguments from the page are ignored; a bad install path, a
missing elevate.exe or a busy handler runs nothing; a cancelled prompt answers not ok. `apply.js` was also dry-run in memory on
the real built bundles: one anchor after 0010, 0010's `aiondxUpdate` kept, both files still parse.

Check (`test-live-mobile.js`, 33 checks): a real app with a bridge-capable core through `tools\live-app.js` (a throwaway profile,
made-up APPDATA/LOCALAPPDATA/cache/work/log folders, `AIONUI_E2E_TEST=1`, `AIONDX_NO_ACTIVATE=1`), with the two scripts evaluated
into the page so the stage needs no rebuild. QA's phone client (`qa-k1-bridge\pair.js`, the CONTRACT §4 crypto) plays the phone:
it reads the URI the QR encodes, sends a pairing request, and checks the SAS it computes against the one on screen; the PC side
is driven only through the UI. The firewall route and `window.aiondxMobile` are stubbed in the page (it checks the page passes the
port and nothing else, shows a refusal, and offers the command when the handler is missing). No rule was ever added or removed
on the test PC; a real run needs Nathan's approval.

## Open points (spec gaps, for the Bridge/API Engineer; the UI keeps a fallback until they land)

- **Re-key has no completion signal.** There is no `GET` for a re-key offer's state, so the dialog cannot tell when the phone
  finished; it polls the device list and has a Done button.
- **`extraUrls` is not in `status`.** The status shape has `urls` but not the saved `extraUrls`, so the field cannot show what
  was saved after a restart (it shows them if a later core adds them to status).
- Placement as above: a card on Settings > Remote with a sidebar entry, not a page of its own.
