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
- **Windows Firewall** row, shown only when `GET /api/mobile/admin/firewall` answers (phase 5; a 404 hides it): the rule's state,
  and when it is absent a button "Allow phones through Windows Firewall (Private networks only)". The button never runs
  anything by itself: it hands the route's `plan` to `window.__aionDxElevateRun(program, args)` if the app provides one (a UAC
  prompt through `elevate.exe`), and otherwise shows the exact command for the user to run in an administrator prompt.

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

Check (`test-live-mobile.js`, 29 checks): a real app with a bridge-capable core through `tools\live-app.js` (a throwaway profile,
made-up APPDATA/LOCALAPPDATA/cache/work/log folders, `AIONUI_E2E_TEST=1`, `AIONDX_NO_ACTIVATE=1`), with the two scripts evaluated
into the page so the stage needs no rebuild. QA's phone client (`qa-k1-bridge\pair.js`, the CONTRACT §4 crypto) plays the phone:
it reads the URI the QR encodes, sends a pairing request, and checks the SAS it computes against the one on screen; the PC side
is driven only through the UI. The firewall route and the elevate runner are stubbed in the page.

## Open points (spec gaps, for the lead and the Bridge/API Engineer)

- **No elevate path from the renderer.** The spec says the firewall button runs the plan "through the app's existing
  elevate.exe path", but the renderer has no way to start a process: the main process would need to expose one (a preload
  function, or a core route). Until then the button shows the command instead. The UI calls `window.__aionDxElevateRun`.
- **Re-key has no completion signal.** There is no `GET` for a re-key offer's state, so the dialog cannot tell when the phone
  finished; it polls the device list and has a Done button.
- **`extraUrls` is not in `status`.** The status shape has `urls` but not the saved `extraUrls`, so the field cannot show what
  was saved after a restart (it shows them if a later core adds them to status).
- Placement as above: a card on Settings > Remote with a sidebar entry, not a page of its own.
