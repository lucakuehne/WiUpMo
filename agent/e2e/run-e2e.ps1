<#
.SYNOPSIS
  Ende-zu-Ende-Test des Selbst-Updates auf einem echten Windows - als Dienst,
  mit geplantem Task und Updater. Gedacht fuer den Windows-Runner von GitHub
  Actions (.github/workflows/agent-e2e.yml); braucht Administratorrechte und
  veraendert das System: Dienst, Task, Programm- und Datenverzeichnis.

.DESCRIPTION
  Gegen ein Test-Backend (fake-backend.mjs), mit drei Fassungen aus dem
  aktuellen Stand und einer alten aus dem Feld:

    1. Uebergang: die alte Fassung installieren, auf A heben (Dateitausch durch
       den alten Updater), dann auf B (Umstellen per binPath), dann auf die
       defekte C - die wird zurueckgenommen.
    2. Neuinstallation von A direkt im Versionsverzeichnis, Deinstallation.

  Bricht beim ersten Fehler ab. Protokolle und Zustand landen in -Artifacts.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Old,
  [Parameter(Mandatory)][string]$A,
  [Parameter(Mandatory)][string]$B,
  [Parameter(Mandatory)][string]$C,
  [string]$Artifacts = (Join-Path $PWD 'e2e-artifacts'),
  [int]$Port = 5080
)

$ErrorActionPreference = 'Stop'

$Backend = "http://127.0.0.1:$Port"
$Token = 'e2e-enrollment-token-0123456789abcdef'
$ServiceName = 'WiUpMoAgent'
$TaskName = 'WiUpMo Agent Updater'
$Root = Join-Path $env:ProgramFiles 'WiUpMo'
$Data = Join-Path $env:ProgramData 'WiUpMo'
$VerificationMinutes = 2

New-Item -ItemType Directory -Force $Artifacts | Out-Null

# --- Hilfen -------------------------------------------------------------------

$script:CurrentStep = 'Vorbereitung'

<#
  Eine Annotation am Lauf. Anders als Protokoll und Artefakt sind sie ohne
  Anmeldung ueber die API lesbar - so laesst sich ein gescheiterter Lauf auch
  von aussen nachvollziehen. Mehrzeilig ueber %0A, wie GitHub es verlangt.
#>
function Write-Annotation([string]$Level, [string]$Title, [string[]]$Lines) {
  if (-not $env:GITHUB_ACTIONS) { return }
  $text = ($Lines -join "`n") -replace '%', '%25' -replace "`r", '' -replace "`n", '%0A'
  Write-Host "::$Level title=$($Title -replace '[:,]', ' ')::$text"
}

function Write-Step([string]$Text) {
  $script:CurrentStep = $Text
  Write-Host ''
  Write-Host "== $Text" -ForegroundColor Cyan
  Write-Annotation 'notice' 'Schritt' @($Text)
}

<# Was beim Fehler zur Erklaerung gebraucht wird, knapp genug fuer eine Annotation. #>
function Write-FailureAnnotations([string]$Message) {
  Write-Annotation 'error' "Gescheitert bei: $script:CurrentStep" @($Message)

  $lines = @("Dienst: $(Get-ServiceState)", "binPath: $(Get-BinPath)")
  try {
    $state = Get-State
    $lines += "Letzter Check-in: $($state.lastCheckin.agentVersion) um $($state.lastCheckin.at)"
    $lines += "Auftrag: $($state.job.targetVersion) $($state.job.state)"
    $lines += $state.reports | ForEach-Object { "Meldung: $($_.state) $($_.agentVersion) $($_.error)" }
  }
  catch { $lines += "Test-Backend nicht erreichbar: $($_.Exception.Message)" }
  $marker = Join-Path $Data 'update.json'
  if (Test-Path $marker) { $lines += "update.json: $((Get-Content $marker -Raw) -replace '\s+', ' ')" }
  Write-Annotation 'error' 'Zustand' $lines

  $logs = Join-Path $Data 'logs'
  if (Test-Path $logs) {
    $updater = Get-ChildItem $logs -Filter 'updater-*.log' | Sort-Object Name | Get-Content -Tail 25
    if ($updater) { Write-Annotation 'error' 'Updater-Protokoll (Ende)' $updater }
    $agent = Get-ChildItem $logs -Filter 'agent-*.log' | Sort-Object Name | Get-Content |
      Where-Object { $_ -match '\[(WRN|ERR|FTL)\]' } | Select-Object -Last 25
    if ($agent) { Write-Annotation 'error' 'Agent-Protokoll (Warnungen und Fehler)' $agent }
  }

  $backendLog = Join-Path $Artifacts 'fake-backend.log'
  if (Test-Path $backendLog) {
    Write-Annotation 'error' 'Test-Backend (Ende)' (Get-Content $backendLog -Tail 25)
  }
}

function Assert-That([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Pruefung gescheitert: $Message" }
  Write-Host "   ok    $Message" -ForegroundColor Green
}

function Wait-Until([string]$What, [int]$Seconds, [scriptblock]$Check) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $result = & $Check
    if ($result) {
      Write-Host "   ok    $What" -ForegroundColor Green
      return $result
    }
    Start-Sleep -Seconds 5
  }
  throw "Zeitueberschreitung nach $Seconds s: $What"
}

function Get-State { Invoke-RestMethod "$Backend/control/state" }

function Get-ExeVersion([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  return ((Get-Item $Path).VersionInfo.ProductVersion -split '\+')[0]
}

function Get-BinPath { (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").PathName }

<#
  Ueber CIM, nicht ueber Get-Service: Dessen Objekte halten einen Handle auf den
  Dienst, und ein Dienst mit offenem Handle bleibt nach "sc delete" als "zum
  Loeschen markiert" stehen - die anschliessende Neuinstallation scheiterte.
  'Running', 'Stopped' usw., oder $null, wenn es ihn nicht gibt.
#>
function Get-ServiceState {
  $service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
  if ($service) { return [string]$service.State }
  return $null
}

<#
  Neu starten ueber sc.exe, aus demselben Grund. Wartet, bis er wieder laeuft.

  Solange der Dienst noch startet, lehnt er das Anhalten ab (sc.exe: 1061), und
  ein einzelnes "stop" ginge verloren. Es wird deshalb wiederholt, bis er steht.
#>
function Restart-Agent {
  Wait-Until 'Dienst angehalten' 120 {
    if ((Get-ServiceState) -eq 'Running') { & sc.exe stop $ServiceName | Out-Null }
    (Get-ServiceState) -eq 'Stopped'
  } | Out-Null
  & sc.exe start $ServiceName | Out-Null
  Wait-Until 'Dienst laeuft' 90 { (Get-ServiceState) -eq 'Running' } | Out-Null
}

function Get-Report([string]$JobId, [string]$State) {
  (Get-State).reports | Where-Object { $_.jobId -eq $JobId -and $_.state -eq $State } | Select-Object -First 1
}

<# Die Einstellungen fuer den Test: keine Startverzoegerung, keine echte Update-Suche, kurze Frist. #>
function Set-TestSettings {
  $file = Join-Path $Root 'appsettings.json'
  $json = Get-Content $file -Raw | ConvertFrom-Json
  $json.Agent | Add-Member -Force -NotePropertyName StartupDelaySeconds -NotePropertyValue 0
  $json.Agent | Add-Member -Force -NotePropertyName SimulateWindowsUpdate -NotePropertyValue $true
  $json.Agent | Add-Member -Force -NotePropertyName UpdateVerificationMinutes -NotePropertyValue $VerificationMinutes
  # Fuer die alte Fassung, die den Schalter oben nicht kennt: lokal suchen, kurz warten.
  $json.Agent | Add-Member -Force -NotePropertyName SearchOnline -NotePropertyValue $false
  $json.Agent | Add-Member -Force -NotePropertyName ComTimeoutSeconds -NotePropertyValue 60
  $json | ConvertTo-Json -Depth 5 | Set-Content $file -Encoding utf8
}

<# Bietet ein Update an und startet den Dienst neu - der naechste Durchlauf kommt dann sofort. #>
function Submit-Update([string]$Version, [string]$File) {
  $body = @{ version = $Version; file = (Resolve-Path $File).Path } | ConvertTo-Json
  $job = Invoke-RestMethod "$Backend/control/offer" -Method Post -Body $body -ContentType 'application/json'
  Restart-Agent
  return $job
}

function Invoke-UpdaterTask {
  & schtasks.exe /Run /TN $TaskName | Out-Null
}

function Save-Evidence([string]$Label) {
  $target = Join-Path $Artifacts $Label
  New-Item -ItemType Directory -Force $target | Out-Null
  if (Test-Path (Join-Path $Data 'logs')) {
    Copy-Item (Join-Path $Data 'logs\*') $target -Force -ErrorAction SilentlyContinue
  }
  foreach ($name in 'update.json', 'install.json') {
    $path = Join-Path $Data $name
    if (Test-Path $path) { Copy-Item $path $target -Force }
  }
  & sc.exe qc $ServiceName *> (Join-Path $target 'sc-qc.txt')
  & schtasks.exe /Query /TN $TaskName /XML *> (Join-Path $target 'task.xml')
  if (Test-Path $Root) {
    Get-ChildItem $Root -Recurse | Select-Object FullName, Length, LastWriteTime |
      Format-Table -AutoSize | Out-String -Width 300 | Set-Content (Join-Path $target 'programm.txt')
  }
  Get-State | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $target 'backend-state.json')
}

function Uninstall-Agent {
  $exe = @((Join-Path $Root 'wiupmo-updater.exe'), (Join-Path $Root 'wiupmo-agent.exe')) |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($exe) { & $exe --uninstall --purge | Out-Host }
  if (Test-Path $Root) { Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue }
}

# --- Ablauf -------------------------------------------------------------------

$versionOld = Get-ExeVersion $Old
$versionA = Get-ExeVersion $A
$versionB = Get-ExeVersion $B
$versionC = Get-ExeVersion $C
Write-Host "Alt $versionOld, A $versionA, B $versionB, C $versionC (defekt)"

$backendLog = Join-Path $Artifacts 'fake-backend.log'
$backendProcess = Start-Process node -ArgumentList @((Join-Path $PSScriptRoot 'fake-backend.mjs'), $Port) `
  -RedirectStandardOutput $backendLog -RedirectStandardError (Join-Path $Artifacts 'fake-backend.err') `
  -PassThru -NoNewWindow

try {
  Wait-Until 'Test-Backend antwortet' 30 { try { Get-State } catch { $null } } | Out-Null

  # Die alte Fassung sucht wirklich; dafuer muss der Dienst starten koennen.
  Set-Service wuauserv -StartupType Manual -ErrorAction SilentlyContinue
  Start-Service wuauserv -ErrorAction SilentlyContinue

  # --- 1. Uebergang ------------------------------------------------------------

  Write-Step "Alte Fassung $versionOld installieren"
  Uninstall-Agent
  & $Old --install --backend-url $Backend --enrollment-token $Token | Out-Host
  Set-TestSettings
  Restart-Agent
  Wait-Until "Check-in von $versionOld" 300 { (Get-State).lastCheckin.agentVersion -eq $versionOld } | Out-Null
  Assert-That ((Get-BinPath) -like "*\WiUpMo\wiupmo-agent.exe*") 'Dienst am alten Ort'

  Write-Step "Update auf ${versionA}: Dateitausch durch den alten Updater"
  $jobA = Submit-Update $versionA $A
  Wait-Until 'A bereitgelegt (installing)' 300 { Get-Report $jobA.jobId 'installing' } | Out-Null
  # Der alte Updater kennt keinen Sofortstart; er laeuft sonst erst mit dem Task.
  Invoke-UpdaterTask
  Wait-Until "A bestaetigt und gemeldet (done)" 600 { Get-Report $jobA.jobId 'done' } | Out-Null
  Assert-That ((Get-ExeVersion (Join-Path $Root 'wiupmo-agent.exe')) -eq $versionA) 'A liegt am alten Ort'
  Wait-Until 'Updater-Kopie auf A nachgezogen' 120 {
    (Get-ExeVersion (Join-Path $Root 'wiupmo-updater.exe')) -eq $versionA
  } | Out-Null
  $taskXml = (& schtasks.exe /Query /TN $TaskName /XML) -join "`n"
  Assert-That ($taskXml -match '<DisallowStartIfOnBatteries>false') 'Task laeuft auch im Akkubetrieb'
  Assert-That ($taskXml -match '<StartWhenAvailable>true') 'Task holt verpasste Laeufe nach'
  Save-Evidence '1-nach-A'

  Write-Step "Update auf ${versionB}: Umstellen per binPath"
  $jobB = Submit-Update $versionB $B
  Wait-Until 'B bestaetigt und gemeldet (done)' 300 { Get-Report $jobB.jobId 'done' } | Out-Null
  Assert-That ((Get-BinPath) -like "*\versions\$versionB\wiupmo-agent.exe*") 'Dienst zeigt auf versions\B'
  Assert-That ((Get-ServiceState) -eq 'Running') 'Dienst laeuft'
  Assert-That (Test-Path (Join-Path $Root 'wiupmo-agent.exe')) 'Vorige Fassung (A am alten Ort) bleibt als Rueckweg'
  Assert-That (-not (Test-Path (Join-Path $Data 'update.json'))) 'Marker aufgeraeumt'
  Wait-Until 'Updater-Kopie auf B nachgezogen' 120 {
    (Get-ExeVersion (Join-Path $Root 'wiupmo-updater.exe')) -eq $versionB
  } | Out-Null
  $updaterLog = Get-ChildItem (Join-Path $Data 'logs') -Filter 'updater-*.log' | Get-Content -Raw
  Assert-That ($updaterLog -match 'Umgestellt auf') 'Updater-Protokoll haelt die Umstellung fest'
  Wait-Until 'Check-in von B mit Task-Zustand' 300 {
    $last = (Get-State).lastCheckin
    $last.agentVersion -eq $versionB -and $last.diagnostics.updaterTaskEnabled -eq $true
  } | Out-Null
  Save-Evidence '2-nach-B'

  Write-Step "Update auf $versionC (defekt): wird zurueckgenommen"
  $jobC = Submit-Update $versionC $C
  Wait-Until 'C bereitgelegt (installing)' 300 { Get-Report $jobC.jobId 'installing' } | Out-Null
  Wait-Until 'Dienst auf C umgestellt' 120 { (Get-BinPath) -like "*\versions\$versionC\*" } | Out-Null
  # C scheitert im ersten Durchlauf und bestaetigt sich nie. Nach Ablauf der
  # Frist nimmt der Updater zurueck; der Task wird hier angestossen, statt auf
  # seinen 5-Minuten-Takt zu warten.
  Start-Sleep -Seconds ($VerificationMinutes * 60 + 15)
  Invoke-UpdaterTask
  Wait-Until 'C zurueckgenommen und gemeldet (failed)' 300 { Get-Report $jobC.jobId 'failed' } | Out-Null
  Assert-That ((Get-BinPath) -like "*\versions\$versionB\*") 'Dienst zeigt wieder auf B'
  Assert-That ((Get-ServiceState) -eq 'Running') 'Dienst laeuft'
  $failed = Get-Report $jobC.jobId 'failed'
  Assert-That ($failed.error -match 'bestaetigte sich nicht') "Begruendung: $($failed.error)"
  Wait-Until 'versions\C aufgeraeumt' 120 { -not (Test-Path (Join-Path $Root "versions\$versionC")) } | Out-Null
  Save-Evidence '3-nach-C'

  # --- 2. Neuinstallation und Deinstallation -----------------------------------

  Write-Step 'Deinstallation'
  Uninstall-Agent
  Wait-Until 'Dienst entfernt' 120 { $null -eq (Get-ServiceState) } | Out-Null
  & schtasks.exe /Query /TN $TaskName *> $null
  Assert-That ($LASTEXITCODE -ne 0) 'Task entfernt'
  Assert-That (-not (Test-Path $Data)) 'Datenverzeichnis entfernt'

  Write-Step "Neuinstallation von $versionA"
  $enrolledBefore = (Get-State).enrollments
  & $A --install --backend-url $Backend --enrollment-token $Token | Out-Host
  Set-TestSettings
  Restart-Agent
  Assert-That ((Get-BinPath) -like "*\versions\$versionA\wiupmo-agent.exe*") 'Dienst zeigt auf versions\A'
  Assert-That ((Get-ExeVersion (Join-Path $Root 'wiupmo-updater.exe')) -eq $versionA) 'Updater-Kopie ist A'
  Assert-That (-not (Test-Path (Join-Path $Root 'wiupmo-agent.exe'))) 'Nichts am alten Ort'
  Wait-Until "Neu registriert, Check-in von $versionA" 300 {
    $state = Get-State
    $state.enrollments -gt $enrolledBefore -and $state.lastCheckin.agentVersion -eq $versionA
  } | Out-Null
  Save-Evidence '4-neu-installiert'

  Write-Step 'Deinstallation'
  Uninstall-Agent
  Wait-Until 'Dienst entfernt' 120 { $null -eq (Get-ServiceState) } | Out-Null
  Assert-That (-not (Test-Path $Data)) 'Datenverzeichnis entfernt'

  Write-Host ''
  Write-Host 'Ende-zu-Ende-Test bestanden.' -ForegroundColor Green
}
catch {
  Write-Host ''
  Write-Host "Ende-zu-Ende-Test gescheitert: $($_.Exception.Message)" -ForegroundColor Red
  Write-FailureAnnotations $_.Exception.Message
  Save-Evidence 'beim-fehler'
  throw
}
finally {
  if ($backendProcess -and -not $backendProcess.HasExited) { $backendProcess.Kill() }
}
