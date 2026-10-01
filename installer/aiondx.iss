; AionDX installer (Inno Setup 6): the whole app, for a PC with no AionUi on it.
; Built by tools\build-release.ps1, which stages the app and writes generated.iss beside this file first;
; do not compile this by hand.
;
; K, September 26th, 2026: "you need to prepare a installer that's all in one based on our source". The
; app is AionUi 2.2.2's own release files (Electron, the bundled AionCore, the unpacked native modules)
; with AionDX's app.asar, built from the stock one by tools\build-release.ps1, and AionDX's per-user
; payload in resources\aiondx. The main program is AionUi.exe renamed AionDX.exe, with the AionDX icon
; and version strings (tools\brand-exe.mjs). AionUi is Apache-2.0; its licence and the list of AionDX's
; changes ship in the install folder.
;
; Per-user install (no admin prompt): %LOCALAPPDATA%\Programs\AionDX. Setup:
;   1. warns when stock AionUi is running: both apps use the same data folder (%APPDATA%\AionUi);
;   2. closes a running AionDX (Restart Manager) and copies the app;
;   3. makes the Start menu shortcut (and a desktop one if chosen) with the app's AppUserModelID,
;      com.aiondx.app (patch 0009 sets the same one in the standalone app), which Windows needs to show
;      its notifications;
;   4. runs the per-user setup, resources\aiondx\bin\aiondx.exe activate: %LOCALAPPDATA%\AionDX\bin
;      first on PATH, the two skills, HKCU\Software\AionDX\AionDX, manifest.user.json, a log. The app runs
;      it again at every start (patch 0009);
;   5. writes the breadcrumbs later installers read: HKCU\Software\AionDX\AionDX (below), the uninstall
;      entry {AppId}_is1 with DisplayVersion, %LOCALAPPDATA%\AionDX\install.json (what is installed, from
;      which installer, with the hashes of the files that matter), history.log, and a log per run in
;      %LOCALAPPDATA%\AionDX\logs, with Inno's own log copied beside it.
; Uninstall runs `aiondx deactivate` first and removes the app folder. Chats, settings and agents in
; %APPDATA%\AionUi stay.

#include "generated.iss"

[Setup]
; Never change AppId: the uninstall key is {AppId}_is1 and every later installer finds this one by it.
AppId={{6C1F4E2A-4B7D-4E0B-9C1E-AE1D0B5DC2A1}
AppName=AionDX
AppVersion={#AppVer}
AppVerName=AionDX {#AppVer}
AppPublisher=AionDX
AppComments=AionDX {#AppVer}: AionUi {#AionUiVer} with the AionDX patches. Build {#BuildId}.
VersionInfoVersion={#AppVerNumeric}
VersionInfoDescription=AionDX {#AppVer} setup
DefaultDirName={localappdata}\Programs\AionDX
DisableDirPage=yes
DefaultGroupName=AionDX
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
CloseApplications=force
CloseApplicationsFilter=*.exe,*.dll,*.asar,*.node
RestartApplications=no
SetupLogging=yes
UninstallLogging=yes
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=2
OutputDir={#OutputDir}
OutputBaseFilename=AionDX-{#AppVer}-setup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\AionDX.exe
UninstallDisplayName=AionDX {#AppVer}
WizardStyle=modern
ChangesEnvironment=yes

[Messages]
WelcomeLabel2=This installs AionDX {#AppVer}: one app for Claude Code, Codex, Gemini, Antigravity and every other agent AionUi supports, with the Loop, Respond now, drafts that survive a restart, and a first screen that brings your settings over from the other AI apps you use.%n%nNo account or sign-in is needed. It installs for you only, so Windows will not ask for an administrator.

[Tasks]
Name: "desktopicon"; Description: "Put an AionDX shortcut on the desktop"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\AionDX"; Filename: "{app}\AionDX.exe"; WorkingDir: "{app}"; AppUserModelID: "com.aiondx.app"; Comment: "AionDX"
Name: "{userdesktop}\AionDX"; Filename: "{app}\AionDX.exe"; WorkingDir: "{app}"; AppUserModelID: "com.aiondx.app"; Comment: "AionDX"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\AionDX"; Flags: uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\AionDX\AionDX"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: dword; ValueName: "SchemaVersion"; ValueData: "1"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVer}"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "Build"; ValueData: "{#BuildId}"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "RendererBuild"; ValueData: "{#RendererBuild}"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "AppId"; ValueData: "{{6C1F4E2A-4B7D-4E0B-9C1E-AE1D0B5DC2A1}"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "Kind"; ValueData: "standalone"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "Exe"; ValueData: "{app}\AionDX.exe"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "PayloadDir"; ValueData: "{app}\resources\aiondx"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "InstallManifest"; ValueData: "{localappdata}\AionDX\install.json"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "LogDir"; ValueData: "{localappdata}\AionDX\logs"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "AionUiBase"; ValueData: "{#AionUiVer}"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "AionCore"; ValueData: "{#AionCoreVer}"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "AsarSha256"; ValueData: "{#AsarSha}"
Root: HKCU; Subkey: "Software\AionDX\AionDX"; ValueType: string; ValueName: "InstalledUtc"; ValueData: "{code:NowUtc}"

[Run]
Filename: "{app}\resources\aiondx\bin\aiondx.exe"; Parameters: "activate --quiet --from setup"; Flags: runhidden waituntilterminated; StatusMsg: "Setting AionDX up for you..."
Filename: "{app}\AionDX.exe"; Description: "Start AionDX now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\resources\aiondx\bin\aiondx.exe"; Parameters: "deactivate --quiet --from uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "AionDXDeactivate"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
type
  TSystemTime = record
    wYear, wMonth, wDayOfWeek, wDay, wHour, wMinute, wSecond, wMilliseconds: Word;
  end;

procedure GetSystemTime(var lpSystemTime: TSystemTime);
  external 'GetSystemTime@kernel32.dll stdcall';

var
  RunLog: String;           { this run's log in %LOCALAPPDATA%\AionDX\logs }
  PreviousVersion: String;

function Pad2(N: Integer): String;
begin
  Result := IntToStr(N);
  if Length(Result) < 2 then Result := '0' + Result;
end;

function NowUtc(Param: String): String;
var T: TSystemTime;
begin
  GetSystemTime(T);
  Result := IntToStr(T.wYear) + '-' + Pad2(T.wMonth) + '-' + Pad2(T.wDay) + 'T' + Pad2(T.wHour) + ':' + Pad2(T.wMinute) + ':' + Pad2(T.wSecond) + 'Z';
end;

function Stamp(): String;
var T: TSystemTime;
begin
  GetSystemTime(T);
  Result := IntToStr(T.wYear) + '-' + Pad2(T.wMonth) + '-' + Pad2(T.wDay) + 'T' + Pad2(T.wHour) + Pad2(T.wMinute) + Pad2(T.wSecond) + 'Z';
end;

function DataDir(): String;
begin
  Result := ExpandConstant('{localappdata}\AionDX');
end;

procedure Say(Line: String);
var A: TArrayOfString;
begin
  Log(Line);
  if RunLog = '' then Exit;
  SetArrayLength(A, 1);
  A[0] := NowUtc('') + ' ' + Line;
  SaveStringsToUTF8FileWithoutBOM(RunLog, A, True);
end;

procedure StartLog(Kind: String);
begin
  ForceDirectories(DataDir() + '\logs');
  RunLog := DataDir() + '\logs\' + Stamp() + '_' + Kind + '_v{#AppVer}.log';
  Say('AionDX ' + Kind + ': release {#AppVer}, build {#BuildId}, renderer {#RendererBuild}, AionUi {#AionUiVer} base, AionCore {#AionCoreVer}');
  Say('user ' + GetUserNameString + ', admin ' + IntToStr(Ord(IsAdmin)) + ', Windows ' + GetWindowsVersionString + ', 64-bit ' + IntToStr(Ord(IsWin64)));
end;

function JsonStr(S: String): String;
begin
  StringChangeEx(S, '\', '\\', True);
  StringChangeEx(S, '"', '\"', True);
  Result := '"' + S + '"';
end;

{ How many processes of this image name are running (WMI). -1 when it cannot tell. }
function Running(Image: String): Integer;
var Locator, Service, Found: Variant;
begin
  Result := -1;
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Found := Service.ExecQuery('SELECT ProcessId FROM Win32_Process WHERE Name = ''' + Image + '''');
    Result := Found.Count;
  except
    Result := -1;
  end;
end;

function SmartAppControlOn(): Boolean;
var V: Cardinal;
begin
  Result := RegQueryDWordValue(HKLM64, 'SYSTEM\CurrentControlSet\Control\CI\Policy', 'VerifiedAndReputablePolicyState', V) and (V = 1);
end;

function InitializeSetup(): Boolean;
var N: Integer;
begin
  Result := False;
  StartLog('install');
  Say('installer ' + ExpandConstant('{srcexe}'));
  if not RegQueryStringValue(HKCU, 'Software\AionDX\AionDX', 'Version', PreviousVersion) then PreviousVersion := '';
  Say('previous AionDX: ' + PreviousVersion);
  N := Running('AionUi.exe');
  Say('AionUi.exe processes running: ' + IntToStr(N));
  if N > 0 then
  begin
    if SuppressibleMsgBox('AionUi is running. AionDX uses the same chats and settings, so close AionUi before you go on.' + #13#10#13#10 +
      'Close AionUi now, then click OK. Cancel stops the install.', mbInformation, MB_OKCANCEL, IDOK) <> IDOK then
    begin
      Say('stopped: the user left AionUi running');
      Exit;
    end;
  end;
  if SmartAppControlOn() then
  begin
    Say('Smart App Control is on');
    if SuppressibleMsgBox('Smart App Control is on for this PC. It blocks programs without a publisher signature, and AionDX has none, so Windows may block it.' + #13#10#13#10 +
      'Install anyway?', mbConfirmation, MB_YESNO, IDYES) <> IDYES then Exit;
  end;
  Result := True;
end;

procedure WriteInstallManifest(State, Action: String);
var A: TArrayOfString; J, Now: String;
begin
  Now := NowUtc('');
  J := '{' +
    '"schema":"aiondx.install/1","kind":"standalone",' +
    '"product":{"name":"AionDX","version":"{#AppVer}","build":"{#BuildId}","rendererBuild":"{#RendererBuild}","appId":"{6C1F4E2A-4B7D-4E0B-9C1E-AE1D0B5DC2A1}"},' +
    '"base":{"aionui":"{#AionUiVer}","aioncore":"{#AionCoreVer}","aionuiExeSha256":"{#BaseExeSha}","stockAsarSha256":"{#StockSha}"},' +
    '"updatedAtUtc":"' + Now + '","state":"' + State + '","lastAction":"' + Action + '","previousVersion":' + JsonStr(PreviousVersion) + ',' +
    '"installDir":' + JsonStr(ExpandConstant('{app}')) + ',"exe":' + JsonStr(ExpandConstant('{app}\AionDX.exe')) + ',' +
    '"payloadDir":' + JsonStr(ExpandConstant('{app}\resources\aiondx')) + ',' +
    '"files":{"AionDX.exe":"{#ExeSha}","resources/app.asar":"{#AsarSha}","resources/bundled-aioncore/win32-x64/aioncore.exe":"{#CoreSha}"},' +
    '"installer":{"tool":"Inno Setup 6","file":"AionDX-{#AppVer}-setup.exe","log":' + JsonStr(RunLog) + '},' +
    '"userManifest":' + JsonStr(DataDir() + '\manifest.user.json') + ',"history":' + JsonStr(DataDir() + '\history.log') +
    '}';
  SetArrayLength(A, 1);
  A[0] := J;
  ForceDirectories(DataDir());
  SaveStringsToUTF8FileWithoutBOM(DataDir() + '\install.json', A, False);
  A[0] := Now + ' ' + Action + ' AionDX {#AppVer} (build {#BuildId}); was ' + PreviousVersion + '; state ' + State + '; log ' + RunLog;
  SaveStringsToUTF8FileWithoutBOM(DataDir() + '\history.log', A, True);
  Say('install manifest ' + DataDir() + '\install.json (' + State + ')');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    Say('installed to ' + ExpandConstant('{app}'));
    WriteInstallManifest('installed', 'install');
  end;
  if CurStep = ssDone then
  begin
    if FileCopy(ExpandConstant('{log}'), DataDir() + '\logs\' + Stamp() + '_inno-setup.log', False) then Say('Inno log copied');
  end;
end;

{ ---- uninstall ---- }

function InitializeUninstall(): Boolean;
var Code: Integer;
begin
  Result := True;
  StartLog('uninstall');
  PreviousVersion := '{#AppVer}';
  { The uninstaller has no Restart Manager: a running AionDX (and the AionCore and agents it started)
    would keep its files locked. }
  if Running('AionDX.exe') > 0 then
  begin
    if SuppressibleMsgBox('AionDX is running, and any agents working in it stop when it closes.' + #13#10#13#10 +
      'Close AionDX and uninstall?', mbConfirmation, MB_OKCANCEL, IDOK) <> IDOK then
    begin
      Say('stopped: the user kept AionDX running');
      Result := False;
      Exit;
    end;
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM AionDX.exe /T /F', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Say('closed AionDX (taskkill exit ' + IntToStr(Code) + ')');
    Sleep(2000);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Say('removed ' + ExpandConstant('{app}') + '; chats and settings in %APPDATA%\AionUi stay');
    WriteInstallManifest('removed', 'uninstall');
  end;
end;
