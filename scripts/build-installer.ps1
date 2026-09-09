param(
    [string]$OutputDirectory = [Environment]::GetFolderPath('Desktop'),
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'release'))
$stageRoot = [IO.Path]::GetFullPath((Join-Path $releaseRoot 'installer-staging'))
$stageApp = Join-Path $stageRoot 'app'
$packagingRoot = Join-Path $repoRoot 'packaging'

function Copy-Tree {
    param(
        [Parameter(Mandatory)] [string]$Source,
        [Parameter(Mandatory)] [string]$Destination,
        [string[]]$ExcludeDirectories = @(),
        [string[]]$ExcludeFiles = @()
    )

    $arguments = @($Source, $Destination, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:1', '/NFL', '/NDL', '/NP')
    if ($ExcludeDirectories.Count) { $arguments += @('/XD') + $ExcludeDirectories }
    if ($ExcludeFiles.Count) { $arguments += @('/XF') + $ExcludeFiles }
    & robocopy @arguments | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "复制失败：$Source -> $Destination（robocopy $LASTEXITCODE）" }
}

if (-not $stageRoot.StartsWith($releaseRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "暂存目录不在 release 目录内：$stageRoot"
}
if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stageApp -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

if (-not $SkipTests) {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw '测试失败，安装包未生成。' }
}

$excludedDirectories = @(
    (Join-Path $repoRoot '.git'),
    (Join-Path $repoRoot '.runtime'),
    (Join-Path $repoRoot 'release'),
    (Join-Path $repoRoot 'packaging'),
    (Join-Path $repoRoot 'docs'),
    (Join-Path $repoRoot 'tests'),
    (Join-Path $repoRoot 'server\tests'),
    (Join-Path $repoRoot 'server\data')
)
$excludedFiles = @(
    (Join-Path $repoRoot '.env'),
    (Join-Path $repoRoot '.env.local'),
    (Join-Path $repoRoot 'server\.env'),
    (Join-Path $repoRoot '一键启动.ps1'),
    (Join-Path $repoRoot '一键启动.command')
)
Copy-Tree -Source $repoRoot -Destination $stageApp -ExcludeDirectories $excludedDirectories -ExcludeFiles $excludedFiles

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeRoot = Split-Path -Parent $nodeCommand.Source
$npmCli = Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) {
    throw "Node 便携运行时缺少 npm CLI：$npmCli"
}
Copy-Tree -Source $nodeRoot -Destination (Join-Path $stageRoot 'runtime\node')

Copy-Item -LiteralPath (Join-Path $packagingRoot 'start-billcompare.cmd') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $packagingRoot 'stop-billcompare.cmd') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $packagingRoot 'stop-billcompare.ps1') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $packagingRoot 'README.txt') -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $repoRoot '一键启动.ps1') -Destination (Join-Path $stageApp 'start-billcompare.ps1')

$forbiddenFiles = @(
    (Join-Path $stageApp '.env'),
    (Join-Path $stageApp '.env.local'),
    (Join-Path $stageApp 'server\.env'),
    (Join-Path $stageApp '.runtime')
)
foreach ($forbidden in $forbiddenFiles) {
    if (Test-Path -LiteralPath $forbidden) { throw "安装包暂存区包含禁止文件：$forbidden" }
}

$package = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
$isccCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe'
)
$iscc = $isccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $iscc) { throw '未找到 Inno Setup 6。请先安装 JRSoftware.InnoSetup。' }

& $iscc "/DSourceDir=$stageRoot" "/DOutputDir=$OutputDirectory" "/DAppVersion=$($package.version)" (Join-Path $packagingRoot 'installer.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup 编译失败。' }

$installer = Join-Path $OutputDirectory "BillCompare-Setup-x64-$($package.version).exe"
if (-not (Test-Path -LiteralPath $installer)) { throw "未找到安装包：$installer" }
$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $installer
Write-Host "`n安装包：$installer"
Write-Host "SHA256：$($hash.Hash)"
