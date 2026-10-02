; AionDX installer (Inno Setup 6): the whole app. For a PC with AionUi on it, a page offers to move over: back up the chats and
; settings, remove AionUi with its own uninstaller, check the chats are intact (see MOVING FROM AIONUI below).
; Built by tools\build-release.ps1, which stages the app and writes generated.iss beside this file first;
; do not compile this by hand.
;
; a request of September 26th, 2026. The
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
;
; MOVING FROM AIONUI (2026-10-01). a request. AionDX keeps its chats, settings and agents in the same folder
; AionUi does, %APPDATA%\AionUi, so retaining them means taking the AionUi program off and leaving that folder alone. When AionUi is
; found (the Windows uninstall list, then its usual folders), a page after the Welcome page offers:
;   - move to AionDX: after the files are copied, `aiondx migrate run` (the Loop tool, patch 0007, 1.12.0) copies the chats database,
;     settings and custom assistants to %LOCALAPPDATA%\AionDX\migration (unless unticked), runs AionUi's own uninstaller silently
;     (one Windows prompt when AionUi was installed for all users), and checks the database is byte for byte as it was;
;   - keep AionUi and install AionDX beside it, as before (they share one data folder: use one at a time).
; Silent installs keep AionUi unless /MIGRATE=yes is given (/AIONUIBACKUP=no skips the backup). /AIONUIDIR=, /AIONUIDATA= point the
; step at another AionUi folder and data folder (for tests). An AionUi newer than the 2.2.2 this build is based on is warned about: a
; newer chats database may not open. The result is written to the run log and shown on the last page.

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
WelcomeLabel2=This installs AionDX {#AppVer}: one app for Claude Code, Codex, Gemini, Antigravity and every other agent AionUi supports, with the Loop, Respond now, drafts that survive a restart, and a first screen that brings your settings over from the other AI apps you use.%n%nNo account or sign-in is needed. It installs for you only, so Windows will not ask for an administrator. If AionUi is on this PC, Setup offers to move your chats and settings over and remove it.

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
; An update the app started itself (/UPDATE=yes, silent) closed the app to replace it: bring it back.
Filename: "{app}\AionDX.exe"; Flags: nowait runasoriginaluser; Check: IsUpdateRun

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
  AionUiFound: Boolean;     { AionUi is installed on this PC }
  AionUiDir, AionUiVer, AionUiScope: String;   { where, which version, 'machine' (all users) or 'user' }
  AionUiNewer: Boolean;     { its version is newer than the AionUi this AionDX is built on }
  AionUiDbBytes: Int64;     { size of its chats database, 0 when there is none }
  AionUiDataOnly: Boolean;  { no AionUi program, but its chats are in the data folder (it was removed, or never had a program here) }
  MigratePage: TInputOptionWizardPage;
  BackupCheck: TNewCheckBox;
  MigrateOutcome: String;   { what the move did, shown on the last page }

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

{ ---- moving from AionUi ---- }

function Param(Name: String): String;
begin
  Result := ExpandConstant('{param:' + Name + '|}');
end;

{ The app's own update (resources of patch 0010: it runs this installer with /VERYSILENT /UPDATE=yes and quits). }
function IsUpdateRun(): Boolean;
begin
  Result := (Param('UPDATE') = 'yes') or (Param('UPDATE') = '1');
end;

function VersionPart(var S: String): Integer;
var P: Integer;
begin
  P := Pos('.', S);
  if P = 0 then begin Result := StrToIntDef(S, 0); S := ''; end
  else begin Result := StrToIntDef(Copy(S, 1, P - 1), 0); S := Copy(S, P + 1, Length(S)); end;
end;

{ -1, 0 or 1: A older than, the same as, newer than B. }
function CompareVersions(A, B: String): Integer;
var I, X, Y: Integer;
begin
  Result := 0;
  for I := 1 to 4 do
  begin
    X := VersionPart(A);
    Y := VersionPart(B);
    if X < Y then begin Result := -1; Exit; end;
    if X > Y then begin Result := 1; Exit; end;
  end;
end;

{ The program in an uninstall command: "C:\Program Files\AionUi\Uninstall AionUi.exe" /allusers }
function UninstallExe(Cmd: String): String;
var P: Integer;
begin
  Result := '';
  Cmd := Trim(Cmd);
  if (Length(Cmd) > 0) and (Cmd[1] = '"') then
  begin
    Delete(Cmd, 1, 1);
    P := Pos('"', Cmd);
    if P > 0 then Result := Copy(Cmd, 1, P - 1);
  end
  else
  begin
    P := Pos('.exe', Lowercase(Cmd));
    if P > 0 then Result := Copy(Cmd, 1, P + 3);
  end;
end;

function FindInUninstallList(Root: Integer; Scope: String): Boolean;
var Names: TArrayOfString; I: Integer; Key, Name, Cmd, Loc, Ver, Dir: String;
begin
  Result := False;
  if not RegGetSubkeyNames(Root, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', Names) then Exit;
  for I := 0 to GetArrayLength(Names) - 1 do
  begin
    Key := 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\' + Names[I];
    if RegQueryStringValue(Root, Key, 'DisplayName', Name) and (CompareText(Name, 'AionUi') = 0) then
    begin
      if not RegQueryStringValue(Root, Key, 'UninstallString', Cmd) then Cmd := '';
      if not RegQueryStringValue(Root, Key, 'InstallLocation', Loc) then Loc := '';
      if not RegQueryStringValue(Root, Key, 'DisplayVersion', Ver) then Ver := '';
      Dir := Loc;
      if (Dir = '') or (not DirExists(Dir)) then Dir := ExtractFileDir(UninstallExe(Cmd));
      { A leftover entry for a program that is gone is not an install. }
      if (Dir <> '') and FileExists(Dir + '\AionUi.exe') then
      begin
        AionUiDir := Dir;
        AionUiVer := Ver;
        AionUiScope := Scope;
        if Pos('/currentuser', Lowercase(Cmd)) > 0 then AionUiScope := 'user';
        if Pos('/allusers', Lowercase(Cmd)) > 0 then AionUiScope := 'machine';
        Result := True;
        Exit;
      end;
    end;
  end;
end;

function AionUiDataDir(): String;
begin
  Result := Param('AIONUIDATA');
  if Result = '' then Result := ExpandConstant('{userappdata}\AionUi');
end;

procedure DetectAionUi();
var Sz: Int64;
begin
  AionUiFound := False;
  AionUiNewer := False;
  AionUiDbBytes := 0;
  if Param('AIONUIDIR') <> '' then
  begin
    if FileExists(Param('AIONUIDIR') + '\AionUi.exe') then
    begin
      AionUiDir := Param('AIONUIDIR');
      AionUiScope := 'user';
      AionUiFound := True;
    end;
  end
  else if FindInUninstallList(HKLM64, 'machine') then AionUiFound := True
  else if FindInUninstallList(HKLM32, 'machine') then AionUiFound := True
  else if FindInUninstallList(HKCU, 'user') then AionUiFound := True
  else if FileExists(ExpandConstant('{autopf}\AionUi\AionUi.exe')) then
  begin
    AionUiDir := ExpandConstant('{autopf}\AionUi');
    AionUiScope := 'machine';
    AionUiFound := True;
  end
  else if FileExists(ExpandConstant('{localappdata}\Programs\AionUi\AionUi.exe')) then
  begin
    AionUiDir := ExpandConstant('{localappdata}\Programs\AionUi');
    AionUiScope := 'user';
    AionUiFound := True;
  end;
  if not AionUiFound then
  begin
    if FileSize64(AionUiDataDir() + '\aionui\aionui-backend.db', Sz) and (Sz > 0) then
    begin
      AionUiDataOnly := True;
      AionUiDbBytes := Sz;
      Say('AionUi: not found, but its chats database is in ' + AionUiDataDir() + ' (' + IntToStr(Sz) + ' bytes): AionDX opens it');
    end
    else Say('AionUi: not found');
    Exit;
  end;
  if AionUiVer = '' then AionUiVer := 'unknown version';
  if (AionUiVer <> 'unknown version') and (CompareVersions(AionUiVer, '{#AionUiVer}') > 0) then AionUiNewer := True;
  if FileSize64(AionUiDataDir() + '\aionui\aionui-backend.db', Sz) then AionUiDbBytes := Sz;
  Say('AionUi: ' + AionUiVer + ' in ' + AionUiDir + ' (' + AionUiScope + '), newer than the base: ' + IntToStr(Ord(AionUiNewer)) + ', chats database ' + IntToStr(AionUiDbBytes) + ' bytes');
end;

function SizeText(Bytes: Int64): String;
begin
  if Bytes >= 1073741824 then Result := FloatToStr(Round(Bytes / 107374182.4) / 10.0) + ' GB'
  else if Bytes >= 1048576 then Result := IntToStr(Bytes div 1048576) + ' MB'
  else Result := 'under 1 MB';
end;

function MovingToAionDx(): Boolean;
begin
  Result := AionUiFound and (MigratePage <> nil) and (MigratePage.SelectedValueIndex = 0);
end;

procedure InitializeWizard();
var Note: TNewStaticText; Where, NoteText: String;
begin
  DetectAionUi();
  if not AionUiFound then Exit;
  if AionUiScope = 'machine' then Where := 'for every user of this PC' else Where := 'for this user';
  MigratePage := CreateInputOptionPage(wpWelcome, 'AionUi is on this PC', 'Move to AionDX, or keep both?',
    'AionUi ' + AionUiVer + ' is installed in ' + AionUiDir + ' (' + Where + '). AionDX keeps its chats, settings and agents in the same folder AionUi does, so they carry over.',
    True, False);
  MigratePage.Add('Move to AionDX: keep my chats and settings, then remove AionUi (recommended)');
  MigratePage.Add('Keep AionUi too: install AionDX next to it. They share one set of chats and settings, so use one at a time');
  if AionUiNewer then MigratePage.SelectedValueIndex := 1 else MigratePage.SelectedValueIndex := 0;
  if (Param('MIGRATE') = 'yes') or (Param('MIGRATE') = '1') then MigratePage.SelectedValueIndex := 0;
  if WizardSilent and (Param('MIGRATE') <> 'yes') and (Param('MIGRATE') <> '1') then MigratePage.SelectedValueIndex := 1;
  MigratePage.CheckListBox.Height := ScaleY(52);

  BackupCheck := TNewCheckBox.Create(MigratePage);
  BackupCheck.Parent := MigratePage.Surface;
  BackupCheck.Left := 0;
  BackupCheck.Top := MigratePage.CheckListBox.Top + MigratePage.CheckListBox.Height + ScaleY(10);
  BackupCheck.Width := MigratePage.SurfaceWidth;
  if AionUiDbBytes > 0 then
  begin
    BackupCheck.Caption := 'Copy my chats and settings to a backup folder first (' + SizeText(AionUiDbBytes) + ', recommended)';
    BackupCheck.Checked := Param('AIONUIBACKUP') <> 'no';
  end
  else
  begin
    BackupCheck.Caption := 'Copy my chats and settings to a backup folder first (no chats found)';
    BackupCheck.Checked := False;
    BackupCheck.Enabled := False;
  end;

  NoteText := 'AionUi is removed with its own uninstaller; your chats, settings and agents stay where they are, and Setup checks the chats database is exactly as it was afterwards.';
  if AionUiScope = 'machine' then NoteText := NoteText + ' AionUi was installed for all users, so Windows will ask for permission once.';
  if AionUiNewer then NoteText := NoteText + ' This AionUi is newer than the AionUi {#AionUiVer} that this AionDX is built on: its chats database may not open in AionDX, so keeping both is the safer first step.';
  Note := TNewStaticText.Create(MigratePage);
  Note.Parent := MigratePage.Surface;
  Note.WordWrap := True;
  Note.AutoSize := False;
  Note.Left := 0;
  Note.Top := BackupCheck.Top + BackupCheck.Height + ScaleY(10);
  Note.Width := MigratePage.SurfaceWidth;
  Note.Height := ScaleY(70);
  Note.Caption := NoteText;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (MigratePage <> nil) and (PageID = MigratePage.ID) then Result := not AionUiFound;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (MigratePage <> nil) and (CurPageID = MigratePage.ID) and MovingToAionDx() and AionUiNewer then
  begin
    Result := SuppressibleMsgBox('This AionUi (' + AionUiVer + ') is newer than the AionUi {#AionUiVer} that this AionDX is built on. Its chats database may not open in AionDX.' + #13#10#13#10 +
      'Move anyway? (A backup is taken first if that box is ticked.)', mbConfirmation, MB_YESNO, IDNO) = IDYES;
    if not Result then Say('left the page: the user did not want to move a newer AionUi');
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := '';
  if MemoDirInfo <> '' then Result := Result + MemoDirInfo + NewLine + NewLine;
  if MemoTasksInfo <> '' then Result := Result + MemoTasksInfo + NewLine + NewLine;
  if AionUiDataOnly then
    Result := Result + 'AionUi chats and settings:' + NewLine + Space + 'found in ' + AionUiDataDir() + ' (' + SizeText(AionUiDbBytes) + '); AionDX opens them, nothing is copied or changed' + NewLine;
  if AionUiFound then
  begin
    if MovingToAionDx() then
    begin
      Result := Result + 'AionUi ' + AionUiVer + ':' + NewLine + Space + 'will be removed with its own uninstaller; your chats and settings stay' + NewLine;
      if BackupCheck.Checked then Result := Result + Space + 'a backup of the chats database and settings is taken first, and checked' + NewLine
      else Result := Result + Space + 'no backup (you unticked it)' + NewLine;
      if AionUiScope = 'machine' then Result := Result + Space + 'Windows will ask for permission once' + NewLine;
    end
    else Result := Result + 'AionUi ' + AionUiVer + ':' + NewLine + Space + 'stays installed, next to AionDX' + NewLine;
  end;
end;

{ Take the chats and settings along and remove AionUi: aiondx.exe migrate run, from the Loop tool in the payload. }
procedure RunMigration();
var Helper, Args, ResultFile, Status, Msg: String; Code, I: Integer; Lines: TArrayOfString;
begin
  Helper := ExpandConstant('{app}\resources\aiondx\bin\aiondx.exe');
  ResultFile := ExpandConstant('{tmp}\aiondx-migrate.result');
  DeleteFile(ResultFile);
  Args := 'migrate run --result "' + ResultFile + '" --log "' + RunLog + '" --backup-dir "' + DataDir() + '\migration\' + Stamp() + '-from-AionUi"';
  if not BackupCheck.Checked then Args := Args + ' --no-backup';
  if Param('AIONUIDIR') <> '' then Args := Args + ' --dir "' + Param('AIONUIDIR') + '" --no-elevate';
  if Param('AIONUIDATA') <> '' then Args := Args + ' --data "' + Param('AIONUIDATA') + '"';
  Say('moving from AionUi: ' + Helper + ' ' + Args);
  WizardForm.StatusLabel.Caption := 'Moving from AionUi: backing up your chats and removing AionUi...';
  WizardForm.FilenameLabel.Caption := '';
  if not Exec(Helper, Args, '', SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Say('could not start the migration step (' + SysErrorMessage(Code) + ')');
    MigrateOutcome := 'AionDX is installed, but its step for removing AionUi could not start, so AionUi is still there. Your chats are untouched.';
    Exit;
  end;
  Say('migration step exit code ' + IntToStr(Code));
  Status := '';
  Msg := '';
  if LoadStringsFromFile(ResultFile, Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      if Copy(Lines[I], 1, 7) = 'status=' then Status := Copy(Lines[I], 8, Length(Lines[I]));
      if Copy(Lines[I], 1, 8) = 'message=' then Msg := Copy(Lines[I], 9, Length(Lines[I]));
    end;
  if Msg = '' then Msg := 'The step for removing AionUi stopped with exit code ' + IntToStr(Code) + '. Your chats were not touched.';
  if Code = 0 then MigrateOutcome := Msg
  else MigrateOutcome := 'AionDX is installed, but AionUi was not removed. ' + Msg;
  Say('migration: ' + Status + ': ' + Msg);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and (MigrateOutcome <> '') then
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 + MigrateOutcome;
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
    if MovingToAionDx() then RunMigration();
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
