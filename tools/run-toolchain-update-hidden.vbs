' run-toolchain-update-hidden.vbs
'
' Launches update-claude-toolchain.js with no console window.
'
' Node is a console application, so a scheduled task pointed straight at node.exe pops a
' window on every run while the user is logged on. The task's own Hidden setting does not
' suppress that. Running through wscript with window style 0 does, and needs no elevation,
' which matters because registering a task with an S4U principal (the other way to get a
' windowless run) is denied without an elevated shell.
'
' Third argument False means do not wait: the task completes immediately and the update
' runs on its own. update-claude-toolchain.js carries its own 15 minute deadline and stop
' file, so nothing here needs to police it.

Dim shell, node, script, cmd
Set shell = CreateObject("WScript.Shell")

node = "C:\Program Files\nodejs\node.exe"
script = "C:\AI Projects\AionDX\tools\update-claude-toolchain.js"

If Not CreateObject("Scripting.FileSystemObject").FileExists(node) Then
  WScript.Quit 1
End If

cmd = """" & node & """ """ & script & """"
shell.Run cmd, 0, False

' Also check upstream against the harvest matrix (added 2026-09-24, the owner's directive to keep
' syncing upstream). Fetches refs only, never checks out; 180 s deadline of its own; writes
' vendor\upstream-sync.json and vendor\upstream-sync.log.
Dim sync
sync = "C:\AI Projects\AionDX\tools\upstream-sync.js"
If CreateObject("Scripting.FileSystemObject").FileExists(sync) Then
  shell.Run """" & node & """ """ & sync & """ --quiet", 0, False
End If
