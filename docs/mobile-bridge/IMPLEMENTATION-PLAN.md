# Mobile bridge: implementation plan and build prerequisites

Written 2026-11-07 by the Bridge/API Engineer. It covers `core-0015-auth-channel` (the K1 fix) and
`core-0016-mobile-bridge` (CONTRACT.md rev 4). This is a plan only. Nothing has been installed or built.

## 1. Build prerequisites, as checked on this PC (2026-11-07)

`tools\build-aioncore.ps1 -Patched` is the build path. It expects:
- **Source:** `AionDX\upstream-aioncore`, a git clone of github.com/iOfficeAI/AionCore that has tag `v0.2.2`. The path
  is hard-coded as `$root\upstream-aioncore`. The script adds a worktree for the tag at `AionDX\vendor\aioncore-src`
  (branch `aiondx/v0.2.2`) and never edits the reference clone.
- **Rust:** rustup at `%USERPROFILE%\.cargo\bin\rustup.exe`, called by its full path (PATH isn't used). The toolchain
  is the one `rust-toolchain.toml` pins, with its components and the `x86_64-pc-windows-msvc` target.
- **Patches:** every `patches\core-*\*.patch`, applied in name order with `git apply`. Then `node tools\brand-names.js`
  renames the package, so a patched build produces `aiondx-app`.
- **Output:** `vendor\aioncore\aioncore.exe` plus `aioncore.json`.

| Need | Version required | Found on this PC | Status |
|---|---|---|---|
| AionCore source | tag `v0.2.2`, commit `47e66d0d151123e973b3fd1e77afcb5671b3f8c5` | **missing**: no `AionDX\upstream-aioncore`, no `vendor\aioncore-src`, no `vendor\aioncore` | to do (a clone, not an install) |
| rustup | any recent | 1.29.1 in `%USERPROFILE%\.cargo` / `.rustup` | present |
| Rust toolchain | `1.95.0` + rustfmt, clippy, rust-analyzer (rust-toolchain.toml) | `1.95.0-x86_64-pc-windows-msvc` with those components; stable too | present |
| Target | `x86_64-pc-windows-msvc` | installed | present |
| MSVC C/C++ build tools | `Microsoft.VisualStudio.Component.VC.Tools.x86.x64` | VS Build Tools 2026 (18.11) **and** VS 2019 Community, both with VC tools | present |
| Windows SDK | 10.x | 10.0.26100.0 and 10.0.17763.0 | present |
| CMake | needed by `aws-lc-sys` and others | 4.4.4 | present (see risk below) |
| NASM | `aws-lc-sys` 0.41 only needs it if prebuilt objects can't be used | **not installed** | probably not needed; confirm on first build |
| Node.js | for `brand-names.js` | 24.19.0 | present |
| git | worktrees, `git apply` | 2.55.0 | present |
| Disk | see estimates | 318 GB free on C: | plenty |

**QA's "no Rust toolchain" finding is a false negative.** The script deliberately keeps Rust off PATH and calls
`%USERPROFILE%\.cargo\bin\cargo.exe` directly, so a PATH check (`where cargo` in a fresh shell, or `rustc --version`)
can miss it. The exact pinned toolchain is already installed. The cargo registry cache exists too (its size wasn't
measured), so some crates may already be downloaded.

**Can `%TEMP%\aiondx-ref\aioncore` serve as the source?** Not as it stands:
- The script hard-codes `AionDX\upstream-aioncore`.
- Junctions are blocked in this environment ("untrusted mount point", the same issue as `C:\AI Projects`).
- It is a shallow (`--depth 1`) clone. That's enough to build the tag, but `tools\upstream-sync.js` fetches and
  compares the upstream clones and expects real history.

Recommended: a full clone directly into place:
```
git clone https://github.com/iOfficeAI/AionCore.git "<AionDX>\upstream-aioncore"
```
That's about 32 MB of working tree plus history. A quicker build-only fallback is
`git clone "%TEMP%\aiondx-ref\aioncore" upstream-aioncore`, which stays shallow and is pinned at the right commit.

**Branch.** The build must run on a branch that already contains `core-0001` to `core-0013`: currently `origin/main`
and `voice-core-elevenlabs`, but not local `main`. On 2026-11-07, all 13 existing patches applied cleanly to a
throwaway copy of the v0.2.2 source (91 files, +4606/−259). New patches are numbered after them: **core-0015** (K1)
and **core-0016** (bridge).

**What would be installed, and where (needs Nathan's approval before anything happens):** with the findings above,
**nothing needs installing.** Network activity during a build that isn't an install:
- the AionCore clone above;
- cargo downloading crates from crates.io into `%USERPROFILE%\.cargo\registry` (654 lockfile packages; some may
  already be cached).

The script would download rustup-init only if `rustup.exe` were missing, and it isn't. **Only if the first build fails
on NASM:** install NASM 2.16.x (official Windows installer, `C:\Program Files\NASM`, added to PATH, needs admin), or
set `AWS_LC_SYS_PREBUILT_NASM=1` for the build if the crate's prebuilt objects are present. Report it before doing
either.

**Risk to watch:** CMake 4.x dropped compatibility with very old `cmake_minimum_required` values. `aws-lc-sys` 0.41 is
recent and should be fine. If any `-sys` crate trips on it, the fix is a per-build `CMAKE_POLICY_VERSION_MINIMUM=3.5`
environment variable, not a reinstall.

**Disk and time (estimates, not measured):**

| Item | Estimate |
|---|---|
| Toolchain (already installed) | ~1.5 GB, already spent |
| `upstream-aioncore` + `vendor\aioncore-src` | ~100–250 MB |
| Cargo registry growth | 0.3–1 GB |
| `target\` for one release build of 27 crates | 4–8 GB (the default release profile, without LTO) |
| First cold build | 20–45 min (the script's deadline is 120 min) |
| Rebuild after changing one patch crate | 2–8 min |
| `cargo test -p <crate>` per crate | 2–10 min the first time |

## 2. core-0015-auth-channel (the K1 fix; small, goes first)

**Problem (§9 K1):** `auth_middleware` turns any agent's runtime token into the full `CurrentUser`. Team lifecycle HTTP
routes check only team ownership, so a non-lead teammate can spawn or hard-remove agents through HTTP, bypassing the
MCP lead-only rule.

**Change:**
1. **`aionui-auth`:** the middleware inserts `AuthChannel::Session` (JWT/cookie) or
   `AuthChannel::RuntimeToken { conversation_id }` next to `CurrentUser`. Also tighten `csrf.rs:43`: skip CSRF only
   when the runtime token actually authenticated the request, not whenever the header is present.
2. **`aionui-team` routes:** for a `RuntimeToken` caller, resolve its conversation to a slot and role. Reject with
   `403 LeaderOnly` unless that caller is the **lead of the same team**. This applies to the HTTP twins of the
   lead-only MCP tools:
   - `POST /agents` (spawn);
   - `DELETE /agents/{slot}`;
   - `POST /agents/{slot}/interrupt`;
   - `PATCH /agents/{slot}/name`;
   - `POST /agents/{slot}/context/reset`;
   - also `DELETE /api/teams/{id}`, `DELETE /session` and `PATCH /name`.

   Session callers (the desktop, and later the mobile bridge) are unaffected.
3. `AuthChannel` is also what core-0016's admin routes use to refuse runtime-token callers (CONTRACT §3.4). That's why
   this patch comes first.

**Tests:**
- unit tests in `aionui-auth` for the channel marking and the CSRF tightening;
- route tests in `aionui-team`, one per case:
  - a teammate's token gets 403 on each route;
  - the lead's token gets 2xx;
  - a session cookie gets 2xx;
  - a token for another team gets 404.
- Regression: `patches\0007-loop-tool\test-loop-tool.js` and `test-mcp-bridge.js`. The loop tool only reads and writes
  `/api/settings/client` and reads team routes, so it must keep working.
- Run `cargo test -p aionui-auth -p aionui-team --lib`. Note the 2 known Windows-path test failures in
  `aionui-conversation` that pre-date AionDX (core-0002's PATCH.md).

**Size:** about 1 day of work, plus a build.

## 3. core-0016-mobile-bridge: phased order

Each phase ends in a buildable, testable state. Phases 1–4 can be run against the mobile team's reference client from
day one, because the wire format and test vectors are already shared.

| Phase | Scope | Tested by | Rough size |
|---|---|---|---|
| **0. Scaffold** | New `aionui-mobile` crate, wired into `aionui-app`. Settings: enabled, port 47734, extraUrls, mdns, tasks.write (on). DPAPI-protected `host.key` (S_h, hostId, dataKey). DB migration: devices, tombstones, broadcasts, send-failure links, read markers. LAN listener with the private-peer filter, off by default. | Unit tests: key-store round trip, migration up/down, peer filter (RFC 1918, 100.64/10, link-local, ULA accepted; public rejected). | 1–2 d |
| **1. Outer protocol and pairing** | `hello`, `pair` (long-poll, lock on first use, `reqTs`, `confirmMode`, `confirmKey`), `session` (the KK-style handshake, A1 revocation notice, `unknown_host`, epk replay cache, 4-session cap), `rpc` (replay window, duplicate-envelope cache, `rid` dedupe), rate limits. Admin routes (pairing offers with SAS, approve/reject, devices, revoke, rekey offers), gated on `AuthChannel::Session` from loopback. | **`vectors.json` as Rust test fixtures, byte for byte with the phone.** Protocol unit tests: replay, lock-on-first, skew, long-poll timing. The mobile team's TypeScript reference client in a Node e2e harness against a locally built aioncore. | 3–4 d |
| **2. Facade, read side** | `/v1/host`, teams, run-state (`state`/`blockedReason`/`runtime`/`turn`/`queue`/`currentTask`), conversations (list/detail, `before` paging), tasks GET, activity (`slotId`, `aroundTask`), assistants, workspaces. The `no_such_route` allowlist. | Handler tests on AionCore's existing service fixtures; JSON-shape tests asserting every field and enum value in the contract. | 3 d |
| **3. Facade, write side and confirm** | Sends (solo, team, `priority: now` steering, broadcast + its table), read markers, wake/stop/shutdown (user-originated `shutdown_request`)/force-remove/spawn/rename/clear-context, session start, task writes (core changes: editable `subject`, clearing `owner`, the owner-notice mirror). Confirm-proof verification (JCS + HMAC, §5.4), re-key, 428/403. | The confirm and re-key vectors; one route test per action, including the 428/403/422 paths; idempotency by `rid`. | 4 d |
| **4. Event-driven state** | Event-bus subscriber: the change journal (epoch/rev, coalescing, `wait` long-poll), message sync cursors (the floor rule), the approvals tracker (live `raw_input` capture, reconciliation, per-backend answer mapping, `freeText`, deny-with-message: native for Claude and aionrs via small changes to `AnswerPermission` and aionrs's reason, follow-up messages otherwise), unread/attention/lastMessage, `send_failed` `messageId` (`turn_id` added to `message.userCreated`). | Event-sequence tests replaying recorded event streams. **Backend-mapping tests are a must:** never a bare string to aionrs; only offered option ids to Claude; `same_as_once` labelling. AionCore's mid-turn mock agent for `pending`/`error`. | 4–5 d |
| **5. Desktop and packaging** | Renderer patch (Settings > Mobile: enable, QR, SAS approve, devices, re-key, the tasks.write switch). mDNS advertiser. Firewall rule, Private profile only; creating it is a system change on the user's PC, done through the existing `elevate.exe` with a prompt. `build-release.ps1` integration. Privacy check. | `tools\dx-harness\click-test.js` additions; the staged app with a throwaway `--user-data-dir`; a live run on the LAN with the real phone app, then over Tailscale and Private Party Net (see the CONTRACT §8 to-verify items). | 3 d |

**Total:** about 18–21 days of bridge work, plus about 1 day for core-0015. Phases 1 and 4 carry the most risk. Phase 1
is helped by the shared vectors; phase 4 depends on event ordering, which is why it relies on recorded-sequence tests
rather than live agents.

## 4. Decisions or approvals still needed before starting

1. Go-ahead to clone AionCore into `AionDX\upstream-aioncore`. It's a download, not an install.
2. Which branch the core patches go on: on top of `origin/main` or `voice-core-elevenlabs` (both have core-0001..0013).
   The `mobile-bridge-contract` docs branch is still based on the older local `main` and would need rebasing.
3. Only if the first build needs it: installing NASM. That's a system install and needs Nathan's approval.
4. Phase 5: creating the Windows firewall rule on users' PCs (UAC prompt through `elevate.exe`) is a product decision.
