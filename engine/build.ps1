param(
    [string]$GoExecutable = '',
    [switch]$SkipTests,
    [switch]$WindowsUpstreamTestExceptions
)
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = Join-Path $taskRoot 'vendor/unframeo'
$outputRoot = Join-Path $PSScriptRoot 'build'
if (-not $GoExecutable) {
    $GoExecutable = Join-Path $taskRoot 'toolchain/go/bin/go.exe'
}
if (-not (Test-Path -LiteralPath $GoExecutable -PathType Leaf)) {
    throw 'A verified Go toolchain is required. Pass -GoExecutable or install it under toolchain/go.'
}
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$env:GOCACHE = Join-Path $taskRoot 'toolchain/gocache'
$env:GOMODCACHE = Join-Path $taskRoot 'toolchain/gomodcache'
$env:GOTOOLCHAIN = 'local'
$env:CGO_ENABLED = '0'
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
Push-Location $sourceRoot
try {
    if (-not $SkipTests) {
        if ($WindowsUpstreamTestExceptions) {
            Write-Warning 'Excluding upstream POSIX permission assertion and fake-grid 50ms ping RTT test on Windows. See engine/VALIDATION.json.'
            & $GoExecutable test -skip '^(TestCreateMakesAnIdentity|TestDialKeepsPinging)$' ./cmd/homey-frameo ./internal/config ./internal/frameo ./internal/mdns ./internal/sdg
        }
        else {
            & $GoExecutable test ./cmd/homey-frameo ./internal/config ./internal/frameo ./internal/mdns ./internal/sdg
        }
        if ($LASTEXITCODE -ne 0) { throw 'Offline engine tests failed.' }
    }
    & $GoExecutable build -trimpath -buildvcs=false -ldflags '-s -w' -o (Join-Path $outputRoot 'homey-frameo-windows-amd64.exe') ./cmd/homey-frameo
    if ($LASTEXITCODE -ne 0) { throw 'Host engine build failed.' }
    $env:GOOS = 'linux'
    foreach ($architecture in @('arm64', 'amd64')) {
        $env:GOARCH = $architecture
        & $GoExecutable build -trimpath -buildvcs=false -ldflags '-s -w' -o (Join-Path $outputRoot "homey-frameo-linux-$architecture") ./cmd/homey-frameo
        if ($LASTEXITCODE -ne 0) { throw "Homey engine build failed for $architecture." }
    }
    $hashes = @{}
    foreach ($name in @('homey-frameo-windows-amd64.exe', 'homey-frameo-linux-arm64', 'homey-frameo-linux-amd64')) {
        $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path $outputRoot $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $hashes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot 'sha256.json') -Encoding utf8
}
finally {
    Pop-Location
    Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
}
