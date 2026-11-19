# core-0024: scheduled tasks are caught up after the PC wakes (November 19th, 2026)

Patch: `0001-resume-after-sleep.patch`. Applies after core-0023, before `tools\brand-names.js`. Target: AionCore v0.2.2.
Work on it: `.tmp\core-base24.ps1`, then `git diff HEAD --output=patches\core-0024-resume-after-sleep\0001-resume-after-sleep.patch`.

On every powerMonitor 'resume' the desktop shell posts `/api/cron/internal/system-resume` with only `x-aionui-internal: 1`
(upstream `packages/desktop/src/index.ts`, registerCronResumeBridge): no cookie, no CSRF token, no session. Upstream refuses it twice
over: the global CSRF layer answers 403 CSRF_INVALID, and the route is inside `cron_routes`, which is wrapped in `auth_middleware`. So
`handle_system_resume` never ran, and a scheduled task due while the PC slept was not caught up on waking, on every PC. Found in the
laptop diagnosis package (G6: "403 CSRF_INVALID at 17:47:59, around a sleep/resume").

The fix: the CSRF layer exempts that one path, and the route moves to `cron_internal_routes`, merged outside the auth layer. The handler
is unchanged: it still refuses a call without `x-aionui-internal: 1` and needs no user. A forged call can only make the scheduler
re-check runs that are due, which it does anyway. The stock desktop call then works as it is.

Tests (`crates/aionui-app/tests/cron_e2e.rs`): `system_resume_from_the_shell_is_served` (the shell's exact request answers 200) and
`system_resume_without_the_internal_header_is_refused` (403).
