<#
.SYNOPSIS
  Test-Stack "wiupmo-test" auf dem Docker-Server: bauen, starten, testen, entfernen.

.DESCRIPTION
  Alles laeuft auf dem Server, gesteuert ueber die Portainer-API
  (deploy/tools/Portainer.psm1). Lokal braucht es weder Docker noch die App.

  Ablauf:
    1. mit -Bauen: Image wiupmo:dev aus dem Arbeitsstand auf dem Server bauen
    2. mit -Migrationstest: altes Image mit Daten, Umstellung, Datenvergleich
    3. Stack anlegen oder auf das Image umstellen
    4. Datenbank leeren, Migrationen laufen lassen, Backend neu starten
    5. Testskripte aus backend/test in die Container legen und ausfuehren:
       Smoke (API), Ad (Samba-AD), Ui (Playwright, Bildschirmfotos nach
       deploy/test-results/)
    6. Stack samt Volumes entfernen, ausser mit -Behalten

  Nie gegen die Produktion: Der Stack ist ein eigener, mit eigener Datenbank.

.EXAMPLE
  .\deploy\test-stack.ps1 -Bauen -Migrationstest
  Voller Lauf vor einem Release.

.EXAMPLE
  .\deploy\test-stack.ps1 -Tests Smoke -Behalten
  Nur der API-Test gegen das vorhandene wiupmo:dev; der Stack bleibt stehen.
#>
[CmdletBinding()]
param(
  # Baut vorher wiupmo:dev aus dem Arbeitsstand (auch Uncommittetes).
  [switch]$Bauen,
  # Zu testendes Image, z. B. ghcr.io/lucakuehne/wiupmo/backend:main.
  [string]$Image = 'wiupmo:dev',
  [ValidateSet('Smoke', 'Ad', 'Ui')][string[]]$Tests = @('Smoke', 'Ad', 'Ui'),
  # Altes Image mit Daten fuellen, dann auf -Image umstellen und vergleichen.
  [switch]$Migrationstest,
  # Fuer den Migrationstest; Standard ist das Image der laufenden Produktion.
  [string]$AltesImage,
  # Stack nach dem Lauf stehen lassen. Entfernen spaeter mit -Entfernen.
  [switch]$Behalten,
  # Nur den Stack samt Volumes entfernen.
  [switch]$Entfernen,
  # Wie -Entfernen, dazu Test-Images und ungenutzte Build-Reste auf dem Server.
  [switch]$Aufraeumen,
  [string]$StackName = 'wiupmo-test',
  [string]$ProduktionsStack = 'wiupmo'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$testDir = Join-Path $repoRoot 'backend\test'
Import-Module (Join-Path $PSScriptRoot 'tools\Portainer.psm1') -Force

if ($StackName -notmatch '-test$') { throw "Der Test-Stack muss auf -test enden, nicht '$StackName'." }

$PlaywrightImage = 'mcr.microsoft.com/playwright:v1.64.1-noble'

# Ein Build belegt voruebergehend mehrere GB. Am 21.10.2026 lief die Platte
# des Servers nach vier Builds voll, und die produktive Datenbank konnte drei
# Minuten lang nicht schreiben. Darunter wird nicht gebaut.
$MinimumFreeGb = 15
$Utf8 = New-Object System.Text.UTF8Encoding $false
$results = [ordered]@{}

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "   $Text" }

# --- Stack ----------------------------------------------------------------------

function Remove-TestStack {
  $stack = Get-PortainerStack -Name $StackName
  if ($stack) {
    Invoke-Portainer DELETE "/api/stacks/$($stack.Id)?endpointId=$($stack.EndpointId)" -TimeoutSeconds 300 | Out-Null
  }
  # Reste ausserhalb von Portainer, etwa nach einem abgebrochenen Lauf.
  foreach ($container in @(Find-Container -Project $StackName -All)) {
    Invoke-Docker DELETE "/containers/$($container.Id)?force=1&v=1" -Allow 404 | Out-Null
  }
  Invoke-Docker DELETE "/networks/$($StackName)_default" -Allow 404, 409 | Out-Null
  Remove-ProjectVolume -Project $StackName
  Write-Info "Stack $StackName samt Volumes entfernt."
}

function Deploy-TestStack([string]$TestImage) {
  $content = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'test-stack.yml'), $Utf8)
  $stackEnv = @(@{ name = 'WIUPMO_IMAGE'; value = $TestImage })
  $stack = Get-PortainerStack -Name $StackName

  # pullImage aus: wiupmo:dev gibt es nur auf dem Server. Fehlende Images wie
  # Postgres oder Playwright zieht Compose trotzdem.
  if ($stack) {
    $body = @{ stackFileContent = $content; env = $stackEnv; prune = $true; pullImage = $false }
    Invoke-Portainer PUT "/api/stacks/$($stack.Id)?endpointId=$($stack.EndpointId)" -Body $body -TimeoutSeconds 1800 | Out-Null
  }
  else {
    $body = @{ name = $StackName; stackFileContent = $content; env = $stackEnv }
    $endpoint = (Get-PortainerConfig).EndpointId
    Invoke-Portainer POST "/api/stacks/create/standalone/string?endpointId=$endpoint" -Body $body -TimeoutSeconds 1800 | Out-Null
  }
}

function Get-TestContainer([string]$Service, [switch]$All) {
  Get-ServiceContainer -Project $StackName -Service $Service -All:$All
}

function Wait-TestStack {
  Wait-ContainerHealthy -Container (Get-TestContainer backend).Id -TimeoutSeconds 300
  if (-not (Wait-ContainerLog -Container (Get-TestContainer runner).Id -Pattern 'Testdateien bereit' -TimeoutSeconds 180)) {
    throw 'Der Runner wurde nicht bereit (Testzertifikate).'
  }
}

# --- Image ----------------------------------------------------------------------

function Build-DevImage {
  Write-Step "Image $Image aus dem Arbeitsstand bauen"
  $free = Get-ServerDiskFreeGb -Project $ProduktionsStack, $StackName
  if ($free -lt $MinimumFreeGb) {
    throw "Auf dem Server sind nur $free GB frei (mindestens $MinimumFreeGb). Erst aufraeumen: .\deploy\test-stack.ps1 -Aufraeumen"
  }
  Write-Info "$free GB frei auf dem Server"
  Push-Location $repoRoot
  try {
    # Was Git kennt oder kennen wuerde - Ignoriertes wie node_modules, .env
    # und das Portainer-Token bleibt draussen.
    $files = @(git ls-files -c -o --exclude-standard) |
      Where-Object { (Test-Path -LiteralPath $_ -PathType Leaf) -and $_ -notmatch 'portainer-token|portainer\.local|(^|/)\.env($|\.)' }
    $head = (git rev-parse HEAD).Trim()
    $dirty = [bool](git status --porcelain)
  }
  finally {
    Pop-Location
  }

  $list = [IO.Path]::GetTempFileName()
  $tar = "$list.tar"
  try {
    [IO.File]::WriteAllLines($list, [string[]]$files, $Utf8)
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -cf $tar -C $repoRoot -T $list
    if ($LASTEXITCODE -ne 0) { throw 'tar ist gescheitert.' }
    Write-Info ("{0} Dateien, {1:N1} MB" -f $files.Count, ((Get-Item $tar).Length / 1MB))

    $revision = $head
    if ($dirty) { $revision += '-dirty' }
    $labels = @{ 'org.opencontainers.image.revision' = $revision; 'org.opencontainers.image.source' = 'arbeitsstand' }
    Invoke-DockerBuild -ContextTar $tar -Tag $Image -Dockerfile 'deploy/Dockerfile' -Labels $labels | ForEach-Object { Write-Info $_ }
    Write-Info "Gebaut: $Image (Revision $revision)"
  }
  finally {
    Remove-Item -LiteralPath $list, $tar -Force -ErrorAction SilentlyContinue
  }
}

function Assert-ImageExists([string]$Reference) {
  if ((Invoke-Docker GET "/images/$Reference/json" -Allow 404 -Full).Status -eq 404) {
    if ($Reference -match '/') { return }  # liegt in einer Registry, Compose zieht es
    throw "Das Image $Reference gibt es auf dem Server nicht. Mit -Bauen erzeugen."
  }
}

# --- Datenbank ------------------------------------------------------------------

function Reset-TestDatabase {
  Write-Step 'Datenbank leeren und neu migrieren'
  $backend = Get-TestContainer backend
  # Die Agent-Binaries gehoeren zu den Eintraegen in der Datenbank.
  Invoke-DockerExec -Container $backend.Id -User root -Command @('sh', '-c', 'find /app/agent-releases -mindepth 1 -delete') | Out-Null
  Invoke-Docker POST "/containers/$($backend.Id)/stop?t=10" -Allow 304 | Out-Null

  $db = Get-TestContainer testdb
  Invoke-DockerExec -Container $db.Id -Command @('psql', '-v', 'ON_ERROR_STOP=1', '-U', 'wiupmo', '-d', 'wiupmo',
    '-c', 'DROP SCHEMA public CASCADE', '-c', 'CREATE SCHEMA public') | Out-Null

  $migrate = Get-TestContainer migrate -All
  $previous = [string](Get-ContainerInfo $migrate.Id).State.FinishedAt
  Invoke-Docker POST "/containers/$($migrate.Id)/start" -Allow 304 | Out-Null
  $code = Wait-ContainerExit -Container $migrate.Id -PreviousFinish $previous
  $log = Get-ContainerLog -Container $migrate.Id -Tail 40
  if ($code -ne 0) { throw "Migrationen gescheitert (Exit-Code $code):`n$log" }
  Write-Info ("{0} Migration(en) ausgefuehrt." -f ([regex]::Matches($log, 'has been executed successfully')).Count)

  Invoke-Docker POST "/containers/$($backend.Id)/start" -Allow 304 | Out-Null
  Wait-ContainerHealthy -Container $backend.Id -TimeoutSeconds 180
}

<# Zeilen je Tabelle - nur Zahlen, keine Inhalte. #>
function Get-TableCounts {
  $sql = "select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', table_name), false, true, '')))[1]::text " +
    "from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1"
  $db = Get-TestContainer testdb
  $out = (Invoke-DockerExec -Container $db.Id -Command @('psql', '-U', 'wiupmo', '-d', 'wiupmo', '-tA', '-F', '|', '-c', $sql)).Stdout
  $counts = [ordered]@{}
  foreach ($line in ($out -split "`n")) {
    if ($line -match '^([^|]+)\|(\d+)\s*$') { $counts[$Matches[1]] = [int]$Matches[2] }
  }
  $counts
}

# --- Tests ----------------------------------------------------------------------

function Invoke-TestScript([string]$Name, [string]$Container, [string[]]$Command, [string]$WorkingDir) {
  Write-Step $Name
  $run = Invoke-DockerExec -Container $Container -Command $Command -WorkingDir $WorkingDir -AllowFailure -TimeoutSeconds 1200
  if ($run.Stdout.Trim()) { Write-Host $run.Stdout.TrimEnd() }
  if ($run.Stderr.Trim()) { Write-Host $run.Stderr.TrimEnd() -ForegroundColor DarkYellow }
  $results[$Name] = ($run.ExitCode -eq 0)
}

function Send-TestScripts {
  $runner = Get-TestContainer runner
  Send-ContainerFile -Container $runner.Id -TargetDir '/app/test' -Path @(
    (Join-Path $testDir 'smoke-lib.mjs'),
    (Join-Path $testDir 'smoke.mjs'),
    (Join-Path $testDir 'ad-smoke.mjs'))
}

function Invoke-AdSetup {
  Write-Step 'Samba-AD einrichten'
  $samba = Get-TestContainer samba
  Send-ContainerFile -Container $samba.Id -TargetDir '/tmp' -Path @((Join-Path $testDir 'ad-setup.sh'))
  $setup = { param($Arg) (Invoke-DockerExec -Container (Get-TestContainer samba).Id -Command @('sh', '/tmp/ad-setup.sh', $Arg) -TimeoutSeconds 300).Stdout.Trim() }

  Write-Info (& $setup 'warten')
  Write-Info (& $setup 'zertifikat')
  Invoke-Docker POST "/containers/$($samba.Id)/restart?t=10" -TimeoutSeconds 120 | Out-Null
  Write-Info (& $setup 'warten')
  Write-Info (& $setup 'daten')
}

function Invoke-UiTest {
  $playwright = Get-TestContainer playwright
  Write-Step 'Playwright vorbereiten'
  if (-not (Wait-ContainerLog -Container $playwright.Id -Pattern 'Playwright bereit' -TimeoutSeconds 600)) {
    throw 'Der Playwright-Container wurde nicht bereit (npm install).'
  }
  Send-ContainerFile -Container $playwright.Id -TargetDir '/work' -Path @((Join-Path $testDir 'ui-smoke.mjs'))
  Invoke-DockerExec -Container $playwright.Id -Command @('sh', '-c', 'rm -rf /out/*') | Out-Null

  Invoke-TestScript -Name 'Oberflaeche' -Container $playwright.Id -WorkingDir '/work' -Command @('node', '/work/ui-smoke.mjs', 'http://backend:3000', '/out')

  $target = Join-Path $PSScriptRoot ('test-results\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Receive-ContainerFile -Container $playwright.Id -SourcePath '/out' -Destination $target
  Write-Info "Bildschirmfotos: $(Join-Path $target 'out')"
}

function Invoke-Migrationstest {
  Write-Step 'Migrationstest: altes Image mit Daten fuellen'
  $old = $AltesImage
  if (-not $old) {
    $prod = Get-ServiceContainer -Project $ProduktionsStack -Service backend
    $old = $prod.ImageID
    Write-Info "Altes Image ist das der Produktion: $($prod.Image) ($($old.Substring(7, 12)))"
  }
  Invoke-Docker POST "/images/$old/tag?repo=wiupmo&tag=alt" | Out-Null

  Remove-TestStack
  Deploy-TestStack 'wiupmo:alt'
  Wait-TestStack
  Send-TestScripts
  Invoke-TestScript -Name 'Testdaten (altes Image)' -Container (Get-TestContainer runner).Id -WorkingDir '/app' -Command @('node', 'test/smoke.mjs', 'http://backend:3000', '--nur-daten')
  $before = Get-TableCounts

  Write-Step "Migrationstest: Umstellung auf $Image"
  Deploy-TestStack $Image
  $migrate = Get-TestContainer migrate -All
  $state = (Get-ContainerInfo $migrate.Id).State
  $log = Get-ContainerLog -Container $migrate.Id
  $applied = [regex]::Matches($log, 'Migration (\S+) has been executed successfully') | ForEach-Object { $_.Groups[1].Value }
  Write-Info ("Neu angewendet: {0}" -f $(if ($applied) { $applied -join ', ' } else { 'keine' }))
  Wait-TestStack
  $after = Get-TableCounts

  $problems = @()
  if ($state.ExitCode -ne 0) { $problems += "migrate endete mit $($state.ExitCode)" }
  foreach ($table in $before.Keys) {
    $now = 0
    if ($after.Contains($table)) { $now = $after[$table] }
    $line = '{0,-24} {1,6} -> {2,6}' -f $table, $before[$table], $now
    if ($now -lt $before[$table]) { $problems += "$table hat Zeilen verloren"; $line += '  VERLOREN' }
    Write-Info $line
  }
  $expected = @(Get-ChildItem (Join-Path $repoRoot 'backend\migrations') -Filter '*.ts').Count
  if ($after['schema_migrations'] -ne $expected) { $problems += "schema_migrations hat $($after['schema_migrations']) Eintraege, erwartet $expected" }

  foreach ($problem in $problems) { Write-Host "   $problem" -ForegroundColor Red }
  $results['Migrationstest'] = ($problems.Count -eq 0) -and $results['Testdaten (altes Image)']
}

function Invoke-Aufraeumen {
  Write-Step 'Test-Images und Build-Reste entfernen'
  $images = @('wiupmo:dev', 'wiupmo:alt', $PlaywrightImage, 'smblds/smblds:latest', 'mcr.microsoft.com/dotnet/sdk:10.0', 'node:24-alpine')
  foreach ($reference in $images) {
    switch (Remove-DockerImage $reference) {
      200 { Write-Info "entfernt: $reference" }
      409 { Write-Info "bleibt (in Benutzung): $reference" }
    }
  }
  Write-Info "$(Remove-DanglingImages) GB an Build-Resten freigegeben, $(Get-ServerDiskFreeGb -Project $ProduktionsStack) GB frei"
}

# --- Ablauf ---------------------------------------------------------------------

if ($Entfernen -or $Aufraeumen) {
  Write-Step "Stack $StackName entfernen"
  Remove-TestStack
  if ($Aufraeumen) { Invoke-Aufraeumen }
  return
}

$failure = $null
try {
  if ($Bauen) { Build-DevImage } else { Assert-ImageExists $Image }
  if ($Migrationstest) { Invoke-Migrationstest }

  Write-Step "Stack $StackName mit $Image"
  Deploy-TestStack $Image
  Wait-TestStack
  Reset-TestDatabase
  Send-TestScripts

  $runner = (Get-TestContainer runner).Id
  if ($Tests -contains 'Smoke') {
    Invoke-TestScript -Name 'Smoke-Test' -Container $runner -WorkingDir '/app' -Command @('node', 'test/smoke.mjs', 'http://backend:3000')
  }
  if ($Tests -contains 'Ad') {
    Invoke-AdSetup
    Invoke-TestScript -Name 'AD-Test' -Container $runner -WorkingDir '/app' -Command @('node', 'test/ad-smoke.mjs', 'http://backend:3000', '/testfiles/tls/ca.pem')
  }
  if ($Tests -contains 'Ui') { Invoke-UiTest }
}
catch {
  $failure = $_
  Write-Host ''
  Write-Host "Abbruch: $($_.Exception.Message)" -ForegroundColor Red
  foreach ($service in @('migrate', 'backend')) {
    $container = @(Find-Container -Project $StackName -Service $service -All) | Select-Object -First 1
    if ($container) {
      Write-Host "--- Protokoll $service (Ende)" -ForegroundColor DarkYellow
      Write-Host (Get-ContainerLog -Container $container.Id -Tail 40)
    }
  }
}
finally {
  Write-Step 'Ergebnis'
  foreach ($name in $results.Keys) {
    if ($results[$name]) { Write-Host "   bestanden  $name" -ForegroundColor Green }
    else { Write-Host "   GESCHEITERT  $name" -ForegroundColor Red }
  }
  if ($Behalten) {
    Write-Info "Der Stack $StackName bleibt stehen. Entfernen: .\deploy\test-stack.ps1 -Entfernen"
  }
  else {
    Remove-TestStack
  }
  # Immer, auch nach einem Abbruch: Die Zwischenstufen eines Builds braucht
  # niemand mehr, und liegen gelassen fuellen sie die Platte des Servers.
  if ($Bauen) {
    try { Write-Info "$(Remove-DanglingImages) GB an Build-Resten freigegeben" }
    catch { Write-Warning "Build-Reste liessen sich nicht entfernen: $($_.Exception.Message)" }
  }
}

if ($failure -or ($results.Values -contains $false)) { exit 1 }
