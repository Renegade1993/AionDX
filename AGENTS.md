# For agents working in this repository

Read these first, in this order:

1. `CORE-CONTRACT.md`: what AionDX needs from its backend. Read it before changing, replacing or rebuilding AionCore (the planned
   AionDX Core): the fourteen core patches and the behaviour each must keep, every route AionDX's page, Claude launcher and tools call,
   the environment an agent process gets, the database tables the tools read, and the AionCore behaviours AionDX works around.
2. `README.md`: what AionDX adds, how to install it, how to build it, and the tests.
3. The `PATCH.md` in each `patches/<NNNN-name>/` and `patches/core-NNNN-<name>/` folder you touch: what it changes, why, and how it was
   checked.

Rules for changes that go to this repository:

- Nothing personal in a commit: no user names, user folders, account names, employers or other projects. `node tools/privacy-check.js
  --staged` runs before a commit; `node tools/security-sweep.js --github` before a push.
- A renderer change passes `node tools/dx-harness/click-test.js`; a backend change passes `cargo test` for the crates it touches and the
  live tests named at the end of `CORE-CONTRACT.md`, on a staged build (`tools/build-release.ps1 -Version X -AionDxCore`).
- Every change to the shipped app gets a numbered patch folder with a `PATCH.md`. The reference clones `upstream/` and
  `upstream-aioncore/` are never edited.
