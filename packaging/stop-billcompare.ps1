$ErrorActionPreference = 'SilentlyContinue'
$installRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'

Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
