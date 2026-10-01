' aiondx-apply.vbs
'
' Starts aiondx-apply.ps1 with no console window, passing through any arguments
' (-DryRun, -Yes, -Detached). Target of the desktop shortcut "AionDX Apply Update", and of the
' one-shot Task Scheduler hand-off the script makes when an agent inside AionUi runs it.
'
' Window style 0 hides PowerShell's console. The script's own message boxes still appear, because
' they are separate windows; they are the only UI.

Dim shell, args, i
Set shell = CreateObject("WScript.Shell")
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\AI Projects\AionDX\tools\aiondx-apply.ps1""" & args, 0, False
