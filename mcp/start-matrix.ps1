# Starts one test MCP server per http/sse sign-in method, on fixed ports, and prints what to enter in the harness.
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File mcp\start-matrix.ps1
# Node 22 is used by path, because the PATH node is 12. Set MCP_NODE to use another binary.
# They listen on this machine only; pass -Lan to reach them from the LAN (their test tokens are fixed).

param([switch]$Lan)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$node = if ($env:MCP_NODE) { $env:MCP_NODE } else { 'C:\Users\Daddy\AppData\Roaming\nvm\v22.20.0\node64.exe' }
$tsx = Join-Path $repo 'node_modules\tsx\dist\cli.mjs'
$server = Join-Path $repo 'mcp\server.ts'
$logDir = Join-Path $env:TEMP 'harness-mcp'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Stop servers from an earlier run of this script (matched by their port in the command line).
$matrix = @(
  @{ transport = 'http';  auth = 'none';    port = 4410 },
  @{ transport = 'http';  auth = 'token';   port = 4411 },
  @{ transport = 'http';  auth = 'headers'; port = 4412 },
  @{ transport = 'http';  auth = 'oauth';   port = 4413 },
  @{ transport = 'sse';   auth = 'none';    port = 4420 },
  @{ transport = 'sse';   auth = 'token';   port = 4421 },
  @{ transport = 'sse';   auth = 'headers'; port = 4422 },
  @{ transport = 'sse';   auth = 'oauth';   port = 4423 }
)
Get-CimInstance Win32_Process -Filter "Name='node64.exe'" |
  Where-Object { $_.CommandLine -match 'mcp\\server\.ts' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

foreach ($m in $matrix) {
  $name = "$($m.transport)-$($m.auth)"
  $args = @($tsx, $server, '--transport', $m.transport, '--auth', $m.auth, '--port', $m.port, '--token', 'test-token', '--header', 'X-Api-Key=test-key')
  if ($Lan) { $args += @('--host', '0.0.0.0') }
  Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "$name.log") -RedirectStandardError (Join-Path $logDir "$name.err")
}
Start-Sleep -Seconds 8

$lanIp = if (-not $Lan) { 'off (-Lan)' } else { (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' } | Select-Object -First 1).IPAddress }
Write-Host ''
Write-Host 'Harness MCP test servers (running):'
foreach ($m in $matrix) {
  $path = if ($m.transport -eq 'sse') { '/sse' } else { '/mcp' }
  $auth = switch ($m.auth) {
    'token'   { 'Bearer token: test-token' }
    'headers' { 'Header X-Api-Key: test-key' }
    'oauth'   { 'OAuth (register + PKCE, auto-approve)' }
    default   { 'none' }
  }
  Write-Host ("  {0,-6} {1,-8} {2}  ->  http://localhost:{3}{4}   (LAN: http://{5}:{3}{4})   auth: {6}" -f $m.transport, $m.auth, '', $m.port, $path, $lanIp, $auth)
}
Write-Host ''
Write-Host 'Command (stdio) server: the harness starts it. Use:'
Write-Host "  command: $node"
Write-Host "  args:    $tsx $server --transport command --auth token"
Write-Host '  env:     MCP_TEST_TOKEN=test-token'
Write-Host "Logs: $logDir"
