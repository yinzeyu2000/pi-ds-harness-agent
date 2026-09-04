[CmdletBinding()]
param(
    [ValidateSet('check', 'build', 'test', 'all')]
    [string]$Mode = 'all'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$runRoot = Join-Path $tempBase ("pi-ds-codex-m0-" + [guid]::NewGuid().ToString('N'))
$marker = Join-Path $runRoot '.m0-baseline-owned'
$savedEnvironment = @{}
$cachedToolDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.pi\agent\bin'

foreach ($entry in Get-ChildItem Env:) {
    $savedEnvironment[$entry.Name] = $entry.Value
}

function Invoke-BaselineStep {
    param([string[]]$Arguments)
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

try {
    New-Item -ItemType Directory -Path $runRoot | Out-Null
    New-Item -ItemType File -Path $marker | Out-Null

    $env:HOME = $runRoot
    $env:USERPROFILE = $runRoot
    $env:TEMP = $runRoot
    $env:TMP = $runRoot
    $env:XDG_CACHE_HOME = Join-Path $runRoot 'cache'
    $env:XDG_CONFIG_HOME = Join-Path $runRoot 'config'
    $env:PI_NO_LOCAL_LLM = '1'
    $env:AWS_EC2_METADATA_DISABLED = 'true'
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GIT_EDITOR = 'true'
    # Keep HOME isolated while reusing already verified native helper binaries.
    # This avoids making a clean regression run depend on GitHub availability.
    $isolatedToolDir = Join-Path $runRoot '.pi\agent\bin'
    foreach ($toolName in @('fd.exe', 'rg.exe')) {
        $cachedTool = Join-Path $cachedToolDir $toolName
        if (Test-Path -LiteralPath $cachedTool) {
            New-Item -ItemType Directory -Path $isolatedToolDir -Force | Out-Null
            Copy-Item -LiteralPath $cachedTool -Destination (Join-Path $isolatedToolDir $toolName) -Force
        }
    }

    $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($null -ne $gitCommand) {
        $gitRoot = Split-Path -Parent (Split-Path -Parent $gitCommand.Source)
        $gitBash = Join-Path $gitRoot 'bin\bash.exe'
        if (Test-Path -LiteralPath $gitBash) {
            $env:PATH = "$(Split-Path -Parent $gitBash);$env:PATH"
        }
    }

    Push-Location $repositoryRoot
    try {
        if ($Mode -in @('check', 'all')) { Invoke-BaselineStep @('run', 'check') }
        if ($Mode -in @('build', 'all')) { Invoke-BaselineStep @('run', 'build:offline') }
        if ($Mode -in @('test', 'all')) { Invoke-BaselineStep @('test') }
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($entry in Get-ChildItem Env:) {
        if (-not $savedEnvironment.ContainsKey($entry.Name)) {
            Remove-Item "Env:$($entry.Name)"
        }
    }
    foreach ($name in $savedEnvironment.Keys) {
        Set-Item "Env:$name" $savedEnvironment[$name]
    }

    $resolvedRunRoot = [System.IO.Path]::GetFullPath($runRoot)
    if ($resolvedRunRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
        $resolvedRunRoot -ne $tempBase -and (Test-Path -LiteralPath $marker)) {
        Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
