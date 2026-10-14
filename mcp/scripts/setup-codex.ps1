param([Parameter(Mandatory = $true)][string]$Url)
$ErrorActionPreference = 'Stop'
$mcpUrl = [Uri]$Url
if (($mcpUrl.Scheme -ne 'https' -and -not ($mcpUrl.Scheme -eq 'http' -and $mcpUrl.Host -in @('localhost', '127.0.0.1', '::1'))) -or $mcpUrl.UserInfo -or $mcpUrl.Query -or $mcpUrl.Fragment) {
    throw 'Use the public HTTPS OpenGym URL (HTTP is allowed only for localhost).'
}
$Url = $mcpUrl.AbsoluteUri.TrimEnd('/')
# The secret is entered locally, never as a command argument or a tracked file.
$mcpSecureToken = Read-Host 'Paste the token from OpenGym Settings > Account > MCP access tokens' -AsSecureString
$mcpPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($mcpSecureToken)
try {
    $mcpToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($mcpPointer)
    if ($mcpToken -notmatch '^ogmcp_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$') { throw 'This is not an OpenGym MCP token.' }
    $mcpSnapshot = Invoke-RestMethod -Uri ($Url.TrimEnd('/') + '/api/mcp/data') -Headers @{ Authorization = 'Bearer ' + $mcpToken } -MaximumRedirection 0 -TimeoutSec 15
    if (-not $mcpSnapshot.user.id -or 'read' -notin $mcpSnapshot.scopes) { throw 'OpenGym did not return a valid profile.' }
    [Environment]::SetEnvironmentVariable('OPENGYM_TOKEN', $mcpToken, 'User')
    $env:OPENGYM_TOKEN = $mcpToken
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($mcpPointer)
    $mcpToken = $null
}
$mcpDirectory = Split-Path $PSScriptRoot -Parent
$mcpRepository = Split-Path $mcpDirectory -Parent
$mcpNode = (Get-Command node -CommandType Application).Source.Replace('\', '/')
$mcpEntry = (Join-Path $mcpDirectory 'src/index.js').Replace('\', '/')
$mcpCwd = $mcpRepository.Replace('\', '/')
$mcpConfigDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
New-Item -ItemType Directory -Path $mcpConfigDir -Force | Out-Null
$mcpConfig = Join-Path $mcpConfigDir 'config.toml'
$mcpExisting = if (Test-Path -LiteralPath $mcpConfig) { [IO.File]::ReadAllText($mcpConfig) } else { '' }
if (Test-Path -LiteralPath $mcpConfig) {
    [IO.File]::Copy($mcpConfig, ($mcpConfig + '.opengym-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff')))
}
$mcpExisting = [regex]::Replace($mcpExisting, '(?ms)^\[mcp_servers\.opengym(?:\.[^\]]+)?\]\r?\n.*?(?=^\[|\z)', '')
$mcpSettings = @"
[mcp_servers.opengym]
command = "$mcpNode"
args = ["$mcpEntry"]
cwd = "$mcpCwd"
env_vars = ["OPENGYM_TOKEN"]
default_tools_approval_mode = "writes"
startup_timeout_sec = 30
tool_timeout_sec = 90
enabled = true

[mcp_servers.opengym.env]
OPENGYM_URL = "$($Url.TrimEnd('/'))"
"@
[IO.File]::WriteAllText($mcpConfig, $mcpExisting.TrimEnd() + "`n`n" + $mcpSettings + "`n", [Text.UTF8Encoding]::new($false))
Write-Output ('OpenGym MCP configured for ' + $mcpSnapshot.user.name + '. Restart Codex Desktop to load the token environment.')
