# Device test handoff (task #01a1be62), stopped 2026-11-08

Device: Galaxy Z Fold5 SM-F946U, serial RFCX5060F9T, folded (cover screen 904x2316).

## Results so far

None of tests 1–7 have run. Each is **not run** and has no screenshots
(`docs/design/screenshots/device/` is empty). The time went on setup:

- **Nathan's dev server on 8081 was down.** Nothing was listening on 8081 and `/status` returned nothing on
  localhost or 192.168.1.95. I didn't touch 8081.
- **Launching from the launcher icon opens the dev-client home screen** ("Development servers"), not the app.
- **The app never loaded.** I ran my own Metro on 8082 with `adb reverse tcp:8082` and pointed the dev client
  at it, but the bundle never loaded:
  - the `exp+aiondx-mobile://expo-development-client/?url=…` deep link didn't connect;
  - pressing BACK to close the keyboard after typing in the URL field closed the launcher.

  Metro and the reverse mapping are both removed now.

## Device state (unchanged)

- font_scale: never changed; read back as **1.15**.
- CAMERA: never revoked or granted. It is still in its original state, which was **not granted** (the app never
  asked). I didn't run `pm grant`, because that would grant something Nathan never granted. Grant it if you want
  it on.
- I added nothing that is still on the phone: no reverse mappings, and `/sdcard/aiondx-ui.xml` is deleted.

## Notes for whoever resumes (adb on this host)

- **adb:** use `C:\Users\nateo\AppData\Local\BeeWare\briefcase\Cache\tools\android_sdk\platform-tools\adb.exe`
  (the running server). In Git Bash, set `MSYS_NO_PATHCONV=1`, otherwise `/sdcard/...` paths get rewritten.
- **Screenshots:** the phone has 2 displays, so plain `screencap -p` writes a warning into the PNG. Use:
  - `screencap -p -d 4630946481096930692` for the cover screen (904x2316);
  - `-d 4630947175568309891` for the inner screen (1812x2176).
- **UI dumps:** `uiautomator dump` can silently leave a stale file in place. `rm` the file first.
- **Connecting the app:** with a server on 8081, connect from the launcher's "http://" field, or open the
  app from the server's QR code. Don't press BACK to close the keyboard; tap Connect directly.

## Left to do (as in the task)

1. Biometric prompt: Allow App Designer's Bash approval, BACK, check the sheet is unchanged, repeat within 30 s,
   and check for the neutral "Couldn't confirm…" hint.
2. App lock: Immediately → HOME → return, then capture the lock screen.
3. font_scale 2.0: dashboard, chat list, thread, approval sheet, Settings, PC detail. Then restore 1.15.
4. Camera/QR: preview with permission, the denied state after `pm revoke --user 0`, then restore.
5. App switcher (KEYCODE_APP_SWITCH): check privacy.
6. Native shutdown and clear-context alerts: button order and default at 1.15.
7. Other device-only items from SPEC §13.

## Human-only steps for Nathan

- **Start the dev server on 8081** (it was down) and open AionDX from the dev launcher.
- **Biometric success:** Approvals → App Designer "Bash" → Allow, touch the fingerprint (or use face unlock).
  The approval should resolve and no hint should show.
- **App lock unlock:** with the lock screen up, tap Unlock and authenticate. The app should come back on the
  same screen.
- **QR scan vibration:** Settings → Pair with my PC → scan the PC's QR. You should feel a haptic tick on
  detect.
- **Inner screen:** unfold and repeat a quick pass of the dashboard, a thread and Settings at the inner width.
