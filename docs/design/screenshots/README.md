# Screenshots for design review

Captured from the **web preview** (Edge, 390×844 viewport, `light/` and `dark/`) with demo data and the local test bridge.
They show layout, colour, wrapping and states. Native chrome (iOS form sheets, Android back, system fonts) will differ slightly on a device.

| File | Screen |
|---|---|
| 01-welcome | P1 Welcome |
| 02-verify-code | P3 Verify (6-digit code, from a real QR scan) |
| 03-camera-needed | P2 camera explainer. A browser can't report "permanently denied", so this is the *ask* state; on device the denied state swaps the button for **Open Settings** |
| 04–06 dashboard-* | D1 with Needs you / Error / Waiting / Working / Idle, approval banner, summary chips |
| 07-approval-sheet-long-command | Approval sheet with a long, wrapped command |
| 08-chat-list | C1 Team segment |
| 09-thread-code-block | C2 with list + code block |
| 10-thread-new-pill | C2 scrolled up with "↓ 1 new" and the "1 other approval waiting" banner |
| 11-task-list, 12/13-task-detail* | T1, T2 with Markdown description |
| 14-lock-screen | Lock screen after a cancelled unlock |
| 15-app-lock-setup, 15b-app-lock-no-lock-toggle-disabled, 16-paired-done | P4 (toggle disabled with No lock), P5 |
| 17/18/19-banner-* | Reconnecting → Can't reach → No longer trusts this phone |
| 20–22 narrow-320-* | 320 pt width (iPhone SE class) as a stand-in for large text |

Recaptured after the SPEC §13 fixes. The ⚡ button in some bottom-left corners is the Expo web dev-tools launcher (dev builds only), not app UI.

**Not covered:** true Dynamic Type / font scale up to 200%. The web preview can't emulate it, so the 320 pt captures are the nearest approximation. Large-text checks need a device or simulator.
