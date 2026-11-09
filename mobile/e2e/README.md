# Web preview E2E harness

Drives the web build in Edge (Playwright) at a 390×844 phone viewport and screenshots each step.
Web is a **layout preview only**: storage falls back to localStorage (`*.web.ts` shims) and Face ID
is replaced by a confirm dialog.

```sh
# one-time, in a scratch dir outside the app (keeps these out of app deps)
npm i playwright-core qrcode && npx esbuild ...   # see below

# 1. app
npx expo start --web --port 8081          # NOT with CI=1 (disables file watching)

# 2. test bridge: reference host protocol + the /v1 mock facade behind the real encrypted channel
npx esbuild e2e/bridge.ts --bundle --platform=node --format=esm --outfile=<scratch>/bridge.mjs --alias:proj=$PWD
node <scratch>/bridge.mjs                 # writes pairing-uri.txt; long-polls pairing, approves on the 3rd request
NO_TASK_WRITE=1 node <scratch>/bridge.mjs # same, but /v1/host omits tasks.write (read-only task UI)
#   POST http://localhost:7777/__fail?on=1|0   simulate the PC dropping off the network
#   POST http://localhost:7777/__revoke        simulate the PC revoking this phone (sends a signed A1 notice)
#   POST http://localhost:7777/__reset         simulate a PC host-key reset (409 unknown_host)
#   POST http://localhost:7777/__confirm?on=0|1 the PC's "Require confirmation" for paired phones (contract §5)
# The bridge serves the same in-memory /v1 facade as the demo host (src/lib/api/mock) and checks
# confirm proofs on sensitive actions with the key it issued at pairing (REQUIRE_CONFIRM=0 to start off).

# 3. fake camera feed showing the pairing QR, then run steps
node e2e/mkqr.mjs                         # qr.mjpeg from pairing-uri.txt
FRESH=1 CAMERA=1 node e2e/shot.mjs steps.json
```

Steps are JSON: `goto`, `tap` (on-top text), `click`, `fill`, `drag`, `longpress`, `scroll`, `dialog`
(`accept` | `dismiss` | prompt answer), `wait`, `shot`, `eval`, `text`. Env: `SCHEME=dark`, `FRESH=1`
(clear storage), `CAMERA=1` (fake camera with qr.mjpeg).
