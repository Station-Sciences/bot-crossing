<#
  Bot Crossing - one-shot installer for Windows (shared-colonies build).

  Fresh install and update in one: sets up a portable Node 22 if the machine has
  none new enough, fetches the code, builds it, installs an autostart entry that
  opens the colony fullscreen in its own window, and opens the firewall for the
  guest + discovery ports so teammates can visit.

  No admin rights are needed for the app itself - Node, the code and the autostart
  entry all live under the current user. Only the firewall rule wants elevation,
  and the script says so and carries on if it cannot add one.

  Usage (from a PowerShell window):
      powershell -ExecutionPolicy Bypass -File install-bot-crossing.ps1

  Options:
      -InstallDir <path>   Where to put everything      (default: %LOCALAPPDATA%\BotCrossing)
      -Branch <name>       Which branch to build        (default: shared-colonies)
      -Monitor <n>         Which monitor to open on, 1-based left-to-right (default: primary)
      -Share               Turn sharing on out of the box (default: off - you toggle it in-app)
      -NoAutostart         Install without the login autostart entry
      -NoLaunch            Do not open the colony when the install finishes
#>

param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'BotCrossing'),
  [string]$Branch = 'shared-colonies',
  [int]$Monitor = 0,
  [switch]$Share,
  [switch]$NoAutostart,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/dimitrihilverda/bot-crossing.git'
$RepoZip = "https://github.com/dimitrihilverda/bot-crossing/archive/refs/heads/$Branch.zip"
$NodeVersion = '22.23.2'
$RepoDir = Join-Path $InstallDir 'bot-crossing'

function Say([string]$m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "  $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "  $m" -ForegroundColor Yellow }

Write-Host "`nBot Crossing installer" -ForegroundColor White
Write-Host "----------------------`n"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# -- 1. Node 22+ --------------------------------------------------------------
function Test-Node([string]$exe) {
  try {
    $v = & $exe --version 2>$null
    if ($v -match 'v(\d+)\.') { return [int]$Matches[1] -ge 22 }
  } catch {}
  return $false
}

$NodeExe = ''
# Prefer a portable Node we installed on a previous run, then whatever is on PATH.
$portable = Join-Path $InstallDir "node\node.exe"
if ((Test-Path $portable) -and (Test-Node $portable)) { $NodeExe = $portable }
elseif (Test-Node 'node') { $NodeExe = (Get-Command node).Source }

if (-not $NodeExe) {
  Say "No Node 22+ found - fetching a portable copy (no admin needed)..."
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $zipName = "node-v$NodeVersion-win-$arch"
  $zipUrl = "https://nodejs.org/dist/v$NodeVersion/$zipName.zip"
  $zipPath = Join-Path $env:TEMP "$zipName.zip"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
  $nodeParent = Join-Path $InstallDir 'node-tmp'
  if (Test-Path $nodeParent) { Remove-Item $nodeParent -Recurse -Force }
  Expand-Archive -Path $zipPath -DestinationPath $nodeParent -Force
  $extracted = Join-Path $nodeParent $zipName
  $nodeFinal = Join-Path $InstallDir 'node'
  if (Test-Path $nodeFinal) { Remove-Item $nodeFinal -Recurse -Force }
  Move-Item $extracted $nodeFinal
  Remove-Item $nodeParent -Recurse -Force
  Remove-Item $zipPath -Force
  $NodeExe = Join-Path $nodeFinal 'node.exe'
  Ok "Node $NodeVersion ($arch) installed under $nodeFinal"
} else {
  Ok "Using Node at $NodeExe"
}

$NodeDir = Split-Path $NodeExe
$NpmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
function Npm([string[]]$npmArgs) {
  & $NodeExe $NpmCli @npmArgs
  if ($LASTEXITCODE -ne 0) { throw "npm $($npmArgs -join ' ') failed" }
}

# -- 2. The code --------------------------------------------------------------
$gitOk = $false
try { git --version | Out-Null; $gitOk = $true } catch {}

if ($gitOk) {
  if (Test-Path (Join-Path $RepoDir '.git')) {
    Say "Updating the existing checkout..."
    git -C $RepoDir fetch --depth 1 origin $Branch 2>$null
    git -C $RepoDir checkout $Branch 2>$null
    git -C $RepoDir reset --hard "origin/$Branch" 2>$null
  } else {
    Say "Cloning Bot Crossing ($Branch)..."
    if (Test-Path $RepoDir) { Remove-Item $RepoDir -Recurse -Force }
    git clone --depth 1 --branch $Branch $RepoUrl $RepoDir
  }
} else {
  Say "Git not found - downloading a source snapshot instead..."
  $zip = Join-Path $env:TEMP "bot-crossing-$Branch.zip"
  Invoke-WebRequest -Uri $RepoZip -OutFile $zip -UseBasicParsing
  $tmp = Join-Path $env:TEMP "bc-src"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
  if (Test-Path $RepoDir) { Remove-Item $RepoDir -Recurse -Force }
  Move-Item $inner.FullName $RepoDir
  Remove-Item $tmp -Recurse -Force
  Remove-Item $zip -Force
  Warn "Installed from a snapshot - re-run this installer to update (or install Git)."
}
Ok "Code is in $RepoDir"

# -- 3. Build -----------------------------------------------------------------
Push-Location $RepoDir
try {
  Say "Installing dependencies..."
  Npm @('install', '--no-audit', '--no-fund')
  Say "Building..."
  Npm @('run', 'build')
  Ok "Build complete"
} finally {
  Pop-Location
}

# -- 4. Colony name + sharing default -----------------------------------------
$dataDir = Join-Path $RepoDir 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$colonyFile = Join-Path $dataDir 'colony.json'
$state = if (Test-Path $colonyFile) { Get-Content $colonyFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{ version = 2 } }
if (-not $state.PSObject.Properties['network']) {
  $state | Add-Member -NotePropertyName network -NotePropertyValue ([pscustomobject]@{ colonyName = $env:USERNAME; share = [bool]$Share; neighbors = @() })
} else {
  if (-not $state.network.colonyName) { $state.network.colonyName = $env:USERNAME }
  if ($Share) { $state.network.share = $true }
}
($state | ConvertTo-Json -Depth 12) | Set-Content -Path $colonyFile -Encoding UTF8
Ok ("Colony name: {0}   Sharing: {1}" -f $state.network.colonyName, $(if ($state.network.share) { 'on' } else { 'off (toggle it in Settings -> Shared colonies)' }))

# -- 5. Autostart + launcher --------------------------------------------------
$startupScript = Join-Path $InstallDir 'start-bot-crossing.ps1'
@"
# Bot Crossing launcher - starts the server hidden and opens it fullscreen.
`$node    = '$NodeExe'
`$project = '$RepoDir'
`$url     = 'http://127.0.0.1:5274'
`$edge    = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
`$chrome  = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
`$profile = Join-Path `$project 'startup\browser-profile'
`$targetMonitor = $Monitor  # 0 = primary, else 1-based left-to-right

Add-Type -AssemblyName System.Windows.Forms
`$screens = [System.Windows.Forms.Screen]::AllScreens
if (`$targetMonitor -ge 1 -and `$targetMonitor -le `$screens.Count) {
  `$t = (`$screens | Sort-Object { `$_.Bounds.X })[`$targetMonitor - 1]
} else {
  `$t = [System.Windows.Forms.Screen]::PrimaryScreen
}
`$x = `$t.Bounds.X; `$y = `$t.Bounds.Y; `$w = `$t.Bounds.Width; `$h = `$t.Bounds.Height

`$listening = Test-NetConnection -ComputerName 127.0.0.1 -Port 5274 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not `$listening) {
  Start-Process -FilePath `$node -ArgumentList 'server/serve.mjs' -WorkingDirectory `$project -WindowStyle Hidden
  for (`$i = 0; `$i -lt 60; `$i++) {
    Start-Sleep -Milliseconds 500
    if (Test-NetConnection -ComputerName 127.0.0.1 -Port 5274 -InformationLevel Quiet -WarningAction SilentlyContinue) { break }
  }
}

`$browser = if (Test-Path `$edge) { `$edge } elseif (Test-Path `$chrome) { `$chrome } else { `$null }
if (`$browser) {
  Start-Process -FilePath `$browser -ArgumentList @(
    "--app=`$url", "--user-data-dir=`$profile",
    "--window-position=`$x,`$y", "--window-size=`$w,`$h",
    '--start-fullscreen', '--no-first-run', '--no-default-browser-check'
  )
} else {
  Start-Process `$url  # no Chromium browser found - open in the default browser
}
"@ | Set-Content -Path $startupScript -Encoding UTF8

$vbs = Join-Path $InstallDir 'bot-crossing.vbs'
@"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""$startupScript""", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII

if (-not $NoAutostart) {
  $startupDir = [Environment]::GetFolderPath('Startup')
  Copy-Item $vbs (Join-Path $startupDir 'bot-crossing.vbs') -Force
  Ok "Autostart installed - Bot Crossing will open when you log in"
} else {
  Warn "Autostart skipped. Launch it any time with: $vbs"
}

# -- 6. Firewall (best effort) ------------------------------------------------
# Opened on ALL profiles (profile=any), not just private, so sharing also works over a VPN
# whose adapter Windows classifies as public/domain. Safe here: the guest listener answers only
# the colleagues the owner has added (an app-level origin check), so an open port is not open access.
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (Test-Admin) {
  try {
    netsh advfirewall firewall delete rule name="Bot Crossing guest" | Out-Null 2>&1
    netsh advfirewall firewall delete rule name="Bot Crossing discovery" | Out-Null 2>&1
    netsh advfirewall firewall add rule name="Bot Crossing guest" dir=in action=allow protocol=TCP localport=5275 profile=any | Out-Null
    netsh advfirewall firewall add rule name="Bot Crossing discovery" dir=in action=allow protocol=UDP localport=5276 profile=any | Out-Null
    Ok "Firewall opened for sharing (TCP 5275, UDP 5276, all networks)"
  } catch {
    Warn "Could not add firewall rules automatically."
  }
} else {
  Warn "Not running as admin - sharing needs the firewall opened once."
  Warn "If teammates cannot see this colony, run these in an elevated PowerShell:"
  Write-Host '      netsh advfirewall firewall add rule name="Bot Crossing guest" dir=in action=allow protocol=TCP localport=5275 profile=any' -ForegroundColor DarkGray
  Write-Host '      netsh advfirewall firewall add rule name="Bot Crossing discovery" dir=in action=allow protocol=UDP localport=5276 profile=any' -ForegroundColor DarkGray
}

# -- 7. Launch ----------------------------------------------------------------
Write-Host ""
Ok "Done."
if (-not $NoLaunch) {
  Say "Opening Bot Crossing..."
  & wscript $vbs
}
Write-Host "`nVisit a teammate: open Settings (S) -> Shared colonies. Turn sharing on to let"
Write-Host "others visit you; add or pick a discovered colony to visit theirs (read-only).`n"
