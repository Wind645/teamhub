param([ValidateSet('alice','bob')][string]$Peer)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if ($Peer) {
    $Host.UI.RawUI.WindowTitle = "Toy Harness - $Peer"
    Write-Host "You are $Peer. Type /exit to close."
    $work = Join-Path $env:TOY_PAIR_DIR $Peer
    & node (Join-Path $PSScriptRoot 'dist/cli.js') --cwd $work --sessions (Join-Path $work 'sessions') --config (Join-Path $env:TOY_PAIR_DIR "$Peer.json")
    if ($LASTEXITCODE) { Read-Host 'Harness exited with an error. Press Enter to close' }
    exit
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$env:TOY_PAIR_DIR = Join-Path $env:TEMP ("toy-pair-" + [guid]::NewGuid())
$env:TEAMHUB_PORT = "$port"
$env:TEAMHUB_HOST = '127.0.0.1'
$env:TEAMHUB_DB = Join-Path $env:TOY_PAIR_DIR 'teamhub.sqlite'
$base = "http://127.0.0.1:$port"
foreach ($name in 'alice','bob') {
    New-Item -ItemType Directory -Path (Join-Path $env:TOY_PAIR_DIR $name) -Force | Out-Null
    $config = Get-Content -Raw (Join-Path $PSScriptRoot 'examples/sustech.deepseek.json') | ConvertFrom-Json
    $config | Add-Member teamhub ([ordered]@{url="$base/mcp/$name"; peer=$name; hookPath=(Join-Path $root 'dist/hook.js'); failClosed=$true})
    [IO.File]::WriteAllText((Join-Path $env:TOY_PAIR_DIR "$name.json"), ($config | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
}
$hub = Start-Process node -WorkingDirectory $root -ArgumentList 'dist/server.js' -PassThru -WindowStyle Hidden
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($hub.HasExited) { throw 'TeamHub exited before startup.' }
        try { Invoke-RestMethod "$base/health" -TimeoutSec 1 | Out-Null; $ready = $true; break } catch { Start-Sleep -Milliseconds 200 }
    }
    if (!$ready) { throw 'TeamHub did not become ready.' }
    if (!$env:TOY_HARNESS_DEEPSEEK_API_KEY) {
        $credentialPath = Join-Path $env:LOCALAPPDATA 'ToyHarness\deepseek.dpapi'
        $secret = if (Test-Path -LiteralPath $credentialPath) {
            ConvertTo-SecureString ([IO.File]::ReadAllText($credentialPath))
        } else {
            Read-Host 'School model API key' -AsSecureString
        }
        if (!$secret.Length) { throw 'A model API key is required.' }
        $env:TOY_HARNESS_DEEPSEEK_API_KEY = [Net.NetworkCredential]::new('', $secret).Password
    }
    $clients = foreach ($name in 'alice','bob') {
        Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Peer $name" -PassThru
    }
    Write-Host "Keep this window open. Type /exit in both peer windows to finish."
    foreach ($client in $clients) { $client.WaitForExit() }
} finally {
    if (!$hub.HasExited) { $hub.Kill(); $hub.WaitForExit() }
}
