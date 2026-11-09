# Desktop UI for the mobile bridge: Settings > Mobile (spec for a parallel implementer)

**What:** the PC side of pairing and managing phones. The bridge itself (core-0015) is done through phase 4. This page
is the only way a user turns it on, pairs a phone, and revokes one. CONTRACT.md §3 (pairing, SAS, devices) and
§5.3 (re-key) are the reference for behavior; this file is the screen-level brief.

**Where:**
- A new app patch, `patches/00NN-mobile-settings/`. Take the next free number on **both** `origin/main`
  (currently 0017) and the voice branch, and confirm with the lead.
- Base it on `origin/main`; the bridge branch `mobile-bridge-impl` is off origin/main. It has no dependency on the
  voice patches.
- Follow the existing patch layout (a `PATCH.md` plus the diff) and the way earlier settings pages were added (look
  at `0015-data-folder` and `0014-mcp-oauth-ui-state` for the renderer side).

**Talking to the bridge:**
- All calls go to aioncore's normal HTTP API, the same client and session the other settings pages use.
- The admin routes refuse anything that isn't the user's own client (a session or local mode → otherwise 403). A
  phone can never reach them; they aren't on the LAN listener at all.
- Responses are AionCore's `ApiResponse<T>` envelope; field names are camelCase.

**Testing:**
- Only with a staged build through `tools\live-app.js`, with a throwaway `--user-data-dir` and a made-up APPDATA.
- Never launch a staged build plainly (patch 0015 points userData at the real `%APPDATA%\AionUi`).
- `tools\dx-harness\click-test.js` additions for the new page.
- The lead's process-kill rules apply.

## Admin routes (all exist now unless marked)

| Route | Body → result | Used by |
|---|---|---|
| `GET /api/mobile/admin/status` | → `{enabled, port, urls[], extraUrls[], hostId, hostName, mdns, tasksWrite, listening, error, lastRecovery}` (`extraUrls` since phase 5: the saved list, as saved) (`lastRecovery: {kind: "database"\|"host_key", at, movedTo} \| null`) | the whole page; poll every 2 s while the page is open |
| `PUT /api/mobile/admin/settings` | any of `{enabled, port, hostName, extraUrls[], mdns, tasksWrite}` → status | the toggle and the advanced settings |
| `POST /api/mobile/admin/pairing-offers` | → `{offerId, uri, expiresAt}` | "Pair a phone" |
| `GET /api/mobile/admin/pairing-offers/{offerId}` | → `{state, request?}`; `state` is `waiting \| request_received \| approved \| rejected \| aborted \| expired`; `request: {deviceName, platform, appVersion, sas, confirmMode}` | poll every 1 s while the QR is shown |
| `POST /api/mobile/admin/pairing-offers/{offerId}/approve` | `{sasConfirmed: true}` → `{deviceId}`. 400 without `sasConfirmed: true`; 409 if the offer isn't waiting for approval | "The codes match" |
| `POST /api/mobile/admin/pairing-offers/{offerId}/reject` | → ok | "They don't match" / Cancel |
| `GET /api/mobile/admin/devices` | → `[{deviceId, name, platform, appVersion, pairedAt, lastSeenAt, lastAddress, activeSessions, requireConfirm, confirmMode}]` | the device list |
| `PATCH /api/mobile/admin/devices/{deviceId}` | `{name?, requireConfirm?}` → device | rename; the "confirm sensitive actions" switch |
| `DELETE /api/mobile/admin/devices/{deviceId}` | → ok | Revoke |
| `POST /api/mobile/admin/devices/{deviceId}/rekey-offers` | → `{offerId, uri, expiresAt}` (`aiondx://rekey?...`) | "Reset confirmation key" (§5.3) |
| `POST /api/mobile/admin/recovery/dismiss` | → ok | the recovery notice's Dismiss |
| `GET /api/mobile/admin/rekey-offers/{offerId}` (phase 5) | → `{state: "pending" \| "completed" \| "failed" \| "expired", expiresAt}`; `offerId` is the device id; 404 when there is none | the re-key dialog closes itself |
| `GET /api/mobile/admin/firewall` (phase 5) | → `{rule: "present" \| "absent", enabled, privateOnly, port, matchesSettings, plan: {program, args[]} \| null}`. Read-only (`netsh ... show rule`). On a non-English Windows the output can't be read and shows as `absent`. | the firewall row |

**Tests (phase 5):** set `AIONDX_MOBILE_BIND=127.0.0.1` in the staged app's environment, and the listener binds loopback only
(the QR then offers `http://127.0.0.1:<port>`, and mDNS is off). Any non-loopback value is ignored.

## Screens

**1. Main panel (Settings > Mobile).**
- **"Phone access" toggle** → `PUT settings {enabled}`. It's off by default.
- Under the toggle, from `status`:
  - listening on `port`;
  - the address list (`urls`);
  - `error` in red when set (e.g. port in use, or the host key unreadable → "Mobile access is unavailable this
    session: <error>").
- **Recovery notice** (when `lastRecovery` is set), as a yellow banner:
  - `database`: "The mobile bridge's data was damaged and has been reset. Paired phones need to pair again."
  - `host_key`: "This PC's mobile identity was reset. Every phone must pair again."
  - Show `movedTo` as a detail line, plus a Dismiss button.
- **"Pair a phone"** button (enabled only while `listening`) → screen 2.
- **Device list** → screen 3.
- **Advanced** (collapsed):
  - port;
  - host name (shown on the phone);
  - extra URLs (one per line, e.g. a Tailscale `100.x` or MagicDNS name);
  - mDNS on/off;
  - "Allow phones to edit tasks" (`tasksWrite`, on by default, §11 #4).

**2. Pairing dialog.**
- Show `uri` as a QR code (any renderer QR lib already in the app, else a small one), plus a 5-minute countdown from
  `expiresAt`.
- Poll the offer. On `request_received`, replace the QR with the phone's name, platform and the **SAS code, large**,
  and two buttons: **"The codes match"** (approve with `sasConfirmed: true`) and **"They don't match"** (reject).
- Copy: "Check that your phone shows the same code. If it doesn't, someone else may be trying to pair."
- `approved` → close and refresh the device list. `rejected`, `aborted` or `expired` → a short message plus "Try
  again".
- Closing the dialog while waiting → reject.

**3. Device list.** One row per phone:
- name (editable), platform, app version, paired date;
- last seen (relative) and last address;
- a dot when `activeSessions > 0`.

Actions:
- **Revoke** (with a confirm dialog) → DELETE.
- **"Confirm sensitive actions on the phone"** switch → `PATCH {requireConfirm}`.
- **"Reset confirmation key"** → a QR dialog like screen 2, but `aiondx://rekey` with no SAS step. The phone scans
  it and the bridge completes on its own; poll the device list.

**4. Firewall row (phase 5, behind the route above).**
- Shows `rule`.
- When absent: a button **"Allow phones through Windows Firewall (Private networks only)"**. It runs `plan` through
  the app's existing `elevate.exe` path (a UAC prompt).
- Never run it automatically. Running it on the dev PC needs Nathan's approval (the lead's gate). Build and click-test
  the button against a stubbed runner.

## Out of scope

- Phone-side UI.
- Any bridge behavior change: if a route seems wrong, tell the Bridge/API Engineer rather than working around it.
- Multi-user: one Core user, as everywhere in AionDX.
