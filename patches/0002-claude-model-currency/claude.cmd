@ECHO off
REM ---------------------------------------------------------------------------
REM  AionUi account router shim.  Rebuilt by AionDX patch 0002 on 2026-09-22.
REM
REM  Routes each AionUi conversation to the correct Claude account by reading
REM  AIONUI_CONVERSATION_ID. Outside AionUi this behaves exactly like stock claude.
REM
REM  WHY IT HAD TO BE REBUILT
REM  `claude install latest` deletes the npm package it replaces, and the npm shim
REM  goes with it. When that happened, `claude` on PATH resolved straight to
REM  %USERPROFILE%\.local\bin\claude.exe, the router stopped being consulted, and both
REM  AionUi agents would have billed the main account again. This shim lives in the
REM  npm directory, which sits earlier on PATH than .local\bin, so it wins the lookup.
REM
REM  Every failure path falls through to launching the native build unmodified.
REM
REM  To revert:  del "%~dp0claude.cmd"     (PATH then finds .local\bin\claude.exe)
REM ---------------------------------------------------------------------------
SETLOCAL
SET "DP0=%~dp0"

IF NOT EXIST "%DP0%claude-account-router.js" GOTO passthrough
WHERE node >NUL 2>NUL
IF ERRORLEVEL 1 GOTO passthrough

node "%DP0%claude-account-router.js" %*
EXIT /B %ERRORLEVEL%

:passthrough
IF EXIST "%USERPROFILE%\.local\bin\claude.exe" (
  "%USERPROFILE%\.local\bin\claude.exe" %*
  EXIT /B %ERRORLEVEL%
)
IF EXIST "%DP0%node_modules\@anthropic-ai\claude-code\bin\claude.exe" (
  "%DP0%node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
  EXIT /B %ERRORLEVEL%
)
ECHO claude.cmd: no Claude Code binary found. Run: claude install latest 1>&2
EXIT /B 1
