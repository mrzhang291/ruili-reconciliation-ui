#ifndef SourceDir
  #error SourceDir is required
#endif

#ifndef OutputDir
  #error OutputDir is required
#endif

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{43CB0103-11B6-487A-B3A8-78E022B9F9C2}
AppName=锐力对账系统
AppVersion={#AppVersion}
AppPublisher=锐力
DefaultDirName={localappdata}\Programs\BillCompare
DefaultGroupName=BillCompare
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=BillCompare-Setup-x64-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
WizardStyle=modern
SetupLogging=yes
CloseApplications=yes
RestartApplications=no
UninstallDisplayName=锐力对账系统
VersionInfoVersion={#AppVersion}
VersionInfoCompany=锐力
VersionInfoDescription=锐力对账系统安装程序
VersionInfoProductName=锐力对账系统

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\BillCompare"; Filename: "{app}\start-billcompare.cmd"; WorkingDir: "{app}"
Name: "{group}\BillCompare"; Filename: "{app}\start-billcompare.cmd"; WorkingDir: "{app}"
Name: "{group}\Stop BillCompare"; Filename: "{app}\stop-billcompare.cmd"; WorkingDir: "{app}"
Name: "{group}\Uninstall BillCompare"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\start-billcompare.cmd"; Description: "启动锐力对账系统"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent shellexec

[UninstallRun]
Filename: "{app}\stop-billcompare.cmd"; RunOnceId: "StopBillCompare"; Flags: runhidden
