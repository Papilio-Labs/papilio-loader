; Inno Setup Script for Papilio Loader Desktop Application
; Requires Inno Setup 6.0 or later (https://jrsoftware.org/isinfo.php)

#define MyAppName "Papilio Loader"
#define MyAppVersion "0.4.0"
#define MyAppPublisher "Gadget Factory"
#define MyAppURL "https://github.com/Papilio-Labs/papilio-loader"
#define MyAppExeName "PapilioLoader.exe"

[Setup]
; App identification
AppId={{8B7D9F3E-4C5A-4D6B-9E2F-1A3B5C7D9E0F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
VersionInfoVersion={#MyAppVersion}

; Installation directories
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes

; Output
OutputDir=installer_output
OutputBaseFilename=PapilioLoader-Setup-{#MyAppVersion}
SetupIconFile=

; Compression
Compression=lzma
SolidCompression=yes

; Platform and compatibility
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
MinVersion=10.0.17763
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog

; Appearance
WizardStyle=modern
DisableWelcomePage=no
LicenseFile=

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startup"; Description: "Run at Windows startup"; GroupDescription: "Additional options:"; Flags: unchecked
Name: "addtopath"; Description: "Add pesptool.exe and esptool.exe to system PATH (for command-line use)"; GroupDescription: "Additional options:"; Flags: unchecked

[Files]
; The main executable
Source: "dist\PapilioLoader.exe"; DestDir: "{app}"; Flags: ignoreversion

; The console debug version
Source: "dist\PapilioLoader-Console.exe"; DestDir: "{app}"; Flags: ignoreversion

; Standalone pesptool.exe for command-line use
Source: "dist\pesptool.exe"; DestDir: "{app}"; Flags: ignoreversion

; Standalone esptool.exe for command-line use
Source: "dist\esptool.exe"; DestDir: "{app}"; Flags: ignoreversion

; NOTE: Don't use "Flags: ignoreversion" on any shared system files

[Icons]
; Start Menu shortcuts
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{#MyAppName} (Debug Console)"; Filename: "{app}\PapilioLoader-Console.exe"
Name: "{group}\pesptool Command Prompt"; Filename: "cmd.exe"; Parameters: "/K echo pesptool.exe is available && echo. && echo Type 'pesptool --help' for usage"; WorkingDir: "{app}"; Comment: "Open command prompt with pesptool.exe"
Name: "{group}\esptool Command Prompt"; Filename: "cmd.exe"; Parameters: "/K echo esptool.exe is available && echo. && echo Type 'esptool --help' for usage"; WorkingDir: "{app}"; Comment: "Open command prompt with esptool.exe"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"

; Desktop shortcut (if selected)
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

; Startup shortcut (if selected)
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: startup

[Run]
; Option to launch the application after installation
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
const
  EnvironmentKey = 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment';

procedure AddToPath(AppDir: string);
var
  PathValue: string;
  ResultCode: Integer;
begin
  if not WizardIsTaskSelected('addtopath') then
    Exit;
    
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathValue) then
  begin
    PathValue := '';
  end;
  
  // Check if path already contains the directory
  if Pos(';' + Uppercase(AppDir) + ';', ';' + Uppercase(PathValue) + ';') > 0 then
    Exit;
    
  // Add the directory to the path
  if PathValue <> '' then
    PathValue := PathValue + ';';
  PathValue := PathValue + AppDir;
  
  if RegWriteStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathValue) then
  begin
    // Notify system of environment variable change
    // This requires admin privileges
  end;
end;

procedure RemoveFromPath(AppDir: string);
var
  PathValue: string;
  StartPos, EndPos: Integer;
begin
  if not RegQueryStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathValue) then
    Exit;
  
  // Find and remove the directory from path
  StartPos := Pos(';' + Uppercase(AppDir) + ';', ';' + Uppercase(PathValue) + ';');
  if StartPos > 0 then
  begin
    // Remove the directory (accounting for the added ';')
    if StartPos = 1 then
      Delete(PathValue, 1, Length(AppDir) + 1)
    else
    begin
      StartPos := Pos(Uppercase(AppDir), Uppercase(PathValue));
      if (StartPos > 1) and (PathValue[StartPos - 1] = ';') then
        Delete(PathValue, StartPos - 1, Length(AppDir) + 1)
      else if StartPos > 0 then
        Delete(PathValue, StartPos, Length(AppDir) + 1);
    end;
    
    RegWriteStringValue(HKEY_LOCAL_MACHINE, EnvironmentKey, 'Path', PathValue);
  end;
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := True;
  
  // Check if the application is already running
  if CheckForMutexes('PapilioLoader') then
  begin
    if MsgBox('Papilio Loader is currently running. Setup cannot continue unless it is closed.' + #13#10#13#10 + 
              'Do you want to close it now?', mbConfirmation, MB_YESNO) = IDYES then
    begin
      // Try to close gracefully
      // Note: This is a simplified approach. For production, you might want to implement
      // a more robust process termination mechanism
      Exec('taskkill', '/F /IM PapilioLoader.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
      Sleep(1000);
      Result := not CheckForMutexes('PapilioLoader');
      if not Result then
        MsgBox('Failed to close Papilio Loader. Please close it manually and try again.', mbError, MB_OK);
    end
    else
      Result := False;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDataDir: String;
begin
  if CurStep = ssPostInstall then
  begin
    // Create the user data directory in AppData
    AppDataDir := ExpandConstant('{localappdata}\papilio-loader-mcp');
    if not DirExists(AppDataDir) then
      CreateDir(AppDataDir);
      
    // Add to PATH if selected
    AddToPath(ExpandConstant('{app}'));
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    // Remove from PATH on uninstall
    RemoveFromPath(ExpandConstant('{app}'));
  end;
end;

[UninstallDelete]
; Clean up user data on uninstall (optional - user might want to keep their files)
; Type: filesandordirs; Name: "{localappdata}\papilio-loader-mcp"

[Messages]
WelcomeLabel2=This will install [name/ver] on your computer.%n%nPapilio Loader is a desktop application for flashing FPGA bit files and ESP32 firmware to your devices.%n%nThe application will run in your system tray and provide a web interface for easy device programming.
