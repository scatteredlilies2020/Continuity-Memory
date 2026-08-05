param(
    [Parameter(Mandatory = $true)]
    [string]$SillyTavernPath
)

$ErrorActionPreference = 'Stop'
$ProjectPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$SillyTavernPath = (Resolve-Path $SillyTavernPath).Path
$ExtensionPath = Join-Path $SillyTavernPath 'public\scripts\extensions\third-party\Continuity-Memory'
$PluginPath = Join-Path $SillyTavernPath 'plugins\continuity-memory'

if ((Test-Path $ExtensionPath) -or (Test-Path $PluginPath)) {
    throw 'Continuity install paths already exist. Remove the old install deliberately before rerunning.'
}

New-Item -ItemType Junction -Path $ExtensionPath -Target (Join-Path $ProjectPath 'extension') | Out-Null
New-Item -ItemType Junction -Path $PluginPath -Target (Join-Path $ProjectPath 'plugin') | Out-Null
Write-Host 'Continuity Memory linked successfully. Enable server plugins, restart SillyTavern, and reload the browser page.'
