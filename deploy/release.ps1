<#
.SYNOPSIS
  Rollt WiUpMo auf dem Portainer-Stack aus: Sicherung, Redeploy, Kontrolle, Aufraeumen.

.DESCRIPTION
  Gesteuert ueber die Portainer-API (deploy/tools/Portainer.psm1); lokal braucht
  es weder Docker noch die App.

    1. Stand pruefen: Arbeitsstand committet, HEAD gleich origin/main
    2. Auf den Lauf von GitHub Actions (backend-image.yml) fuer HEAD warten
    3. Sicherung: pg_dump -Fc im Datenbank-Container nach
       /var/lib/postgresql/sicherungen, Lesbarkeit mit pg_restore -l pruefen
    4. git/redeploy des Stacks mit pullImage und den bestehenden Variablen
    5. Kontrolle: Revision des Images, Migrationen, Startmeldung, Fehler im
       Log, Healthcheck, Zahlen aus der Datenbank (keine Inhalte)
    6. Altes Image entfernen, sobald es kein Container mehr benutzt

  Vorher gehoert der volle Lauf auf dem Test-Stack dazu:
    .\deploy\test-stack.ps1 -Bauen -Migrationstest

.EXAMPLE
  .\deploy\release.ps1
  Den gepushten Stand von main ausrollen.

.EXAMPLE
  .\deploy\release.ps1 -Tag sha-1a2b3c4
  Gezielt zu einem frueheren Commit zurueckgehen. -Tag main stellt wieder auf den Standard.

.EXAMPLE
  .\deploy\release.ps1 -NurKontrolle
  Nichts aendern, nur die Kontrollen gegen den laufenden Stack.
#>
[CmdletBinding()]
param(
  # Image-Tag statt main: sha-<commit> zum Zurueckgehen, eine Version wie 0.2.0,
  # oder main, um eine Festlegung aufzuheben. Setzt BACKEND_IMAGE im Stack.
  [string]$Tag,
  # Nicht auf GitHub Actions warten - fuer einen Commit, der kein neues Image
  # braucht (etwa nur deploy/docker-compose.yml).
  [switch]$OhneImage,
  # Nichts aendern, nur kontrollieren.
  [switch]$NurKontrolle,
  # Fehlerzeilen aus dem Log ausgeben statt sie nur zu zaehlen.
  [switch]$ZeigeFehler,
  [string]$StackName = 'wiupmo'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Import-Module (Join-Path $PSScriptRoot 'tools\Portainer.psm1') -Force

$Workflow = 'backend-image.yml'
$Curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$Utf8 = New-Object System.Text.UTF8Encoding $false

function Write-Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "   $Text" }
function Write-Ok([string]$Text) { Write-Host "   ok    $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "   !     $Text" -ForegroundColor Yellow }
function Write-Bad([string]$Text) { Write-Host "   FEHLER $Text" -ForegroundColor Red; $script:failed = $true }

function Invoke-Git {
  $output = & git -C $repoRoot @args
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') ist gescheitert." }
  $output
}

function Get-GitHubSlug {
  $remote = [string](Invoke-Git remote get-url origin)
  if ($remote -notmatch 'github\.com[:/]([^/]+)/([^/]+?)(\.git)?$') { throw "Kein GitHub-Remote: $remote" }
  "$($Matches[1])/$($Matches[2])"
}

<#
  Die Actions-API ist fuer ein oeffentliches Repository ohne Anmeldung lesbar.

  --ssl-revoke-best-effort: Im Firmennetz erreicht Schannel die Sperrlisten
  nicht und bricht sonst mit CRYPT_E_NO_REVOCATION_CHECK ab. Das Zertifikat
  wird weiterhin geprueft, nur eine nicht erreichbare Sperrliste zaehlt nicht
  als Fehler.
#>
function Invoke-GitHub([string]$Path) {
  $out = [IO.Path]::GetTempFileName()
  try {
    $code = & $Curl -sS --ssl-revoke-best-effort -o $out -w '%{http_code}' -H 'Accept: application/vnd.github+json' -H 'User-Agent: wiupmo-release' "https://api.github.com$Path"
    if ($LASTEXITCODE -ne 0) { throw "GitHub-API nicht erreichbar (curl $LASTEXITCODE)." }
    $text = [IO.File]::ReadAllText($out, $Utf8)
    if ([int]$code -ne 200) { throw "GitHub-API $Path -> $code $text" }
    $text | ConvertFrom-Json
  }
  finally {
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  }
}

function Get-LatestSuccessfulRun {
  $runs = Invoke-GitHub "/repos/$slug/actions/workflows/$Workflow/runs?branch=main&event=push&status=success&per_page=1"
  $run = @($runs.workflow_runs) | Select-Object -First 1
  if (-not $run) { throw "Es gibt keinen erfolgreichen Lauf von $Workflow auf main." }
  $run
}

function Wait-ImageBuild([string]$Sha) {
  Write-Step "GitHub Actions: Image fuer $($Sha.Substring(0, 7))"
  $appear = (Get-Date).AddSeconds(90)
  $deadline = (Get-Date).AddMinutes(30)
  $last = ''
  while ($true) {
    $runs = Invoke-GitHub "/repos/$slug/actions/workflows/$Workflow/runs?head_sha=$Sha&event=push&per_page=5"
    $run = @($runs.workflow_runs) | Sort-Object { [long]$_.run_number } -Descending | Select-Object -First 1
    if (-not $run) {
      if ((Get-Date) -gt $appear) {
        throw "Kein Lauf von $Workflow fuer $Sha. Aendert der Commit das Image nicht (nur Doku oder Compose), dann mit -OhneImage ausrollen."
      }
    }
    elseif ($run.status -eq 'completed') {
      if ($run.conclusion -ne 'success') { throw "Der Lauf endete mit '$($run.conclusion)': $($run.html_url)" }
      Write-Ok "Lauf erfolgreich: $($run.html_url)"
      return
    }
    elseif ($run.status -ne $last) {
      Write-Info "Lauf $($run.status) ... $($run.html_url)"
      $last = $run.status
    }
    if ((Get-Date) -gt $deadline) { throw 'Zeitueberschreitung beim Warten auf GitHub Actions.' }
    Start-Sleep -Seconds 20
  }
}

<#
  Der Commit, aus dem ein Image stammen muss. main ist der letzte erfolgreiche
  Lauf, sha-<commit> und Versionen loest Git auf. Ein fremdes Image wird nicht
  verglichen.
#>
function Resolve-ExpectedRevision([string]$Image) {
  if (-not $Image.StartsWith("$($imageRepo):")) { return $null }
  $tagPart = $Image.Substring($imageRepo.Length + 1)
  if ($tagPart -eq 'main') { return (Get-LatestSuccessfulRun).head_sha }
  if ($tagPart -match '^sha-([0-9a-f]{7,40})$') { return [string](Invoke-Git rev-parse "$($Matches[1])^{commit}") }
  [string](Invoke-Git rev-parse "backend/v$tagPart^{commit}")
}

<# Zahlen aus der Datenbank, keine Inhalte. #>
function Get-DatabaseCounts {
  $pg = Get-ServiceContainer -Project $StackName -Service postgres
  $sql = "select (select count(*) from devices), (select count(*) from devices where status = 'active'), " +
    "(select count(*) from device_checkins), (select count(*) from schema_migrations), " +
    "(select name from schema_migrations order by timestamp desc limit 1)"
  $out = (Invoke-DockerExec -Container $pg.Id -Command @('sh', '-c', 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F "|" -c "$1"', 'zahlen', $sql)).Stdout.Trim()
  $parts = $out -split '\|'
  [pscustomobject]@{
    Devices       = [int]$parts[0]
    ActiveDevices = [int]$parts[1]
    Checkins      = [int]$parts[2]
    Migrations    = [int]$parts[3]
    LastMigration = $parts[4]
  }
}

function Backup-Database([string]$Label) {
  Write-Step 'Sicherung der Datenbank'
  $pg = Get-ServiceContainer -Project $StackName -Service postgres
  $name = "wiupmo-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$Label.dump"
  # Im Volume der Datenbank, aber ausserhalb des Datenverzeichnisses. Schuetzt
  # vor einer misslungenen Migration, nicht vor dem Verlust des Servers.
  $shell = @'
set -e
dir=/var/lib/postgresql/sicherungen
mkdir -p "$dir"
pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f "$dir/$1"
echo "eintraege=$(pg_restore -l "$dir/$1" | grep -c '^[0-9]' || true)"
echo "bytes=$(stat -c %s "$dir/$1")"
echo "anzahl=$(ls -1 "$dir" | wc -l)"
echo "belegt=$(du -sh "$dir" | cut -f1)"
'@ -replace "`r", ''
  $run = Invoke-DockerExec -Container $pg.Id -User postgres -Command @('sh', '-c', $shell, 'sicherung', $name)

  $values = @{}
  foreach ($line in ($run.Stdout -split "`n")) {
    if ($line -match '^(\w+)=(.*)$') { $values[$Matches[1]] = $Matches[2].Trim() }
  }
  if (-not $values['eintraege'] -or [int]$values['eintraege'] -lt 1) {
    throw "Die Sicherung $name ist leer oder nicht lesbar - Abbruch vor dem Ausrollen."
  }
  Write-Ok ("{0}: {1:N1} MB, {2} Eintraege laut pg_restore -l" -f $name, ([long]$values['bytes'] / 1MB), $values['eintraege'])
  Write-Info "Sicherungen im Volume: $($values['anzahl']) Dateien, $($values['belegt'])"
}

function Invoke-Redeploy([string]$Image) {
  Write-Step "Ausrollen: $Image"
  # Alle bisherigen Variablen gehen wieder mit - was hier fehlt, ist danach
  # aus dem Stack verschwunden. Nur BACKEND_IMAGE wird gesetzt oder entfernt.
  $newEnv = @($stackEnv | Where-Object { $_.name -ne 'BACKEND_IMAGE' } | ForEach-Object { @{ name = $_.name; value = [string]$_.value } })
  if ($Image -ne "$($imageRepo):main") { $newEnv += @{ name = 'BACKEND_IMAGE'; value = $Image } }

  $git = $stack.GitConfig
  $authenticated = $null -ne $git.Authentication
  $body = @{
    env                      = $newEnv
    prune                    = $false
    pullImage                = $true
    repositoryReferenceName  = $git.ReferenceName
    repositoryAuthentication = $authenticated
    stackName                = $stack.Name
  }
  if ($authenticated) { $body.repositoryUsername = $git.Authentication.Username }

  Invoke-Portainer PUT "/api/stacks/$($stack.Id)/git/redeploy?endpointId=$($stack.EndpointId)" -Body $body -TimeoutSeconds 900 | Out-Null
  Write-Ok 'Portainer hat den Stack neu ausgerollt.'
}

function Test-Deployment([string]$Expected, $Before, [string]$OldBackendId) {
  Write-Step 'Kontrolle'
  $backend = Get-ServiceContainer -Project $StackName -Service backend
  $info = Get-ContainerInfo $backend.Id
  $revision = [string]$info.Config.Labels.'org.opencontainers.image.revision'
  $started = ConvertTo-UnixTime $info.State.StartedAt

  Write-Info "Image:    $($info.Config.Image)"
  if ($OldBackendId -and $OldBackendId -eq $backend.Id) { Write-Info 'Container unveraendert - das Image war schon aktuell.' }
  if (-not $Expected) {
    Write-Warn "Revision $revision - kein Vergleich, das Image stammt nicht aus $imageRepo."
  }
  elseif ($revision -eq $Expected) {
    Write-Ok "Revision $($revision.Substring(0, 7)) wie erwartet"
  }
  else {
    Write-Bad "Revision $revision, erwartet $Expected"
  }

  $migrate = Get-ServiceContainer -Project $StackName -Service migrate -All
  $migrateState = (Get-ContainerInfo $migrate.Id).State
  $applied = @([regex]::Matches((Get-ContainerLog -Container $migrate.Id), 'Migration (\S+) has been executed successfully') | ForEach-Object { $_.Groups[1].Value })
  if ($migrateState.ExitCode -ne 0) { Write-Bad "migrate endete mit $($migrateState.ExitCode)" }
  elseif ($applied.Count -gt 0) { Write-Ok "Migrationen angewendet: $($applied -join ', ')" }
  else { Write-Ok 'Keine neuen Migrationen' }

  if (Wait-ContainerLog -Container $backend.Id -Pattern 'Backend laeuft auf Port' -Since $started -TimeoutSeconds 180) {
    Write-Ok 'Startmeldung im Log'
  }
  else {
    Write-Bad 'Keine Startmeldung im Log'
  }

  $lines = (Get-ContainerLog -Container $backend.Id -Since $started) -split "`n"
  $errors = @($lines | Where-Object { $_ -match '\bERROR\b' })
  $warnings = @($lines | Where-Object { $_ -match '\bWARN\b' })
  $summary = "Log seit dem Start: $($errors.Count) Fehler, $($warnings.Count) Warnungen"
  if ($errors.Count -gt 0) {
    Write-Warn "$summary (Einzelheiten mit -ZeigeFehler)"
    if ($ZeigeFehler) { $errors | Select-Object -First 20 | ForEach-Object { Write-Info $_.Trim() } }
  }
  else {
    Write-Ok $summary
  }

  $health = (Invoke-DockerExec -Container $backend.Id -Command @('wget', '-qO-', 'http://127.0.0.1:3000/health')).Stdout | ConvertFrom-Json
  if ($health.status -eq 'ok' -and $health.database -eq 'ok') { Write-Ok 'Healthcheck im Container' } else { Write-Bad "Healthcheck: $($health | ConvertTo-Json -Compress)" }

  $publicUrl = (Get-PortainerConfig).PublicUrl
  if ($publicUrl) {
    $outside = & $Curl -s --max-time 10 "$publicUrl/health"
    if ($LASTEXITCODE -eq 0 -and ($outside -join '') -match '"status":"ok"') { Write-Ok "Healthcheck von aussen ($publicUrl)" }
    else { Write-Bad "Healthcheck von aussen ($publicUrl) gescheitert" }
  }

  # Die Datenbank liegt auf derselben Platte wie alle Images des Servers. Am
  # 21.10.2026 lief sie voll, und PostgreSQL konnte drei Minuten nicht schreiben.
  $free = Get-ServerDiskFreeGb -Project $StackName
  if ($free -lt 10) { Write-Warn "Nur noch $free GB frei auf dem Server - aufraeumen (test-stack.ps1 -Aufraeumen)." }
  else { Write-Ok "$free GB frei auf dem Server" }

  $now = Get-DatabaseCounts
  $expectedMigrations = $null
  if ($Expected) {
    $expectedMigrations = @(Invoke-Git ls-tree --name-only $Expected 'backend/migrations/' | Where-Object { $_ -like '*.ts' }).Count
  }
  $line = "Datenbank: $($now.Devices) Geraete ($($now.ActiveDevices) aktiv), $($now.Checkins) Check-ins, $($now.Migrations) Migrationen bis $($now.LastMigration)"
  if ($null -eq $expectedMigrations -or $now.Migrations -eq $expectedMigrations) { Write-Ok $line }
  elseif ($now.Migrations -gt $expectedMigrations) {
    Write-Warn "$line - die Datenbank ist neuer als das Image ($expectedMigrations). Beim Zurueckgehen ueber eine Migration hinweg ggf. die Sicherung zurueckspielen (deploy/README.md)."
  }
  else {
    Write-Bad "$line - erwartet $expectedMigrations"
  }
  if ($Before -and $now.Devices -lt $Before.Devices) { Write-Bad "Vor dem Ausrollen waren es $($Before.Devices) Geraete." }

  $info.Image
}

function Remove-OldImage([string]$OldImageId, [string]$NewImageId) {
  Write-Step 'Altes Image'
  if (-not $OldImageId -or $OldImageId -eq $NewImageId) { Write-Info 'Kein altes Image zu entfernen.'; return }

  $users = @(Invoke-Docker GET "/containers/json?all=1&filters=$(ConvertTo-DockerFilter @{ ancestor = @($OldImageId) })")
  if ($users.Count -gt 0) { Write-Info "Bleibt: noch $($users.Count) Container benutzen es."; return }

  $image = Invoke-Docker GET "/images/$OldImageId/json" -Allow 404 -Full
  if ($image.Status -eq 404) { Write-Info 'Schon entfernt.'; return }
  $tags = @(($image.Text | ConvertFrom-Json).RepoTags | Where-Object { $_ -and $_ -ne '<none>:<none>' })

  # Ein getaggtes Image verschwindet mit seinem letzten Tag. Nie mit Gewalt.
  $references = $tags
  if ($tags.Count -eq 0) { $references = @($OldImageId) }
  foreach ($reference in $references) {
    $status = Remove-DockerImage $reference
    if ($status -eq 409) { Write-Warn "Docker lehnt das Entfernen ab: $reference"; return }
  }
  Write-Ok "Entfernt: $($OldImageId.Substring(7, 12)) $($tags -join ', ')"
}

# --- Ablauf ---------------------------------------------------------------------

$script:failed = $false
$slug = Get-GitHubSlug
$imageRepo = "ghcr.io/$($slug.ToLower())/backend"

$stack = Get-PortainerStack -Name $StackName
if (-not $stack) { throw "Stack '$StackName' gibt es in Portainer nicht." }
if (-not $stack.GitConfig) { throw "Stack '$StackName' ist kein Git-Stack; git/redeploy geht nur dort." }
$stackEnv = @($stack.Env | Where-Object { $_ })
$pinned = @($stackEnv | Where-Object { $_.name -eq 'BACKEND_IMAGE' -and $_.value }) | Select-Object -First 1

$targetImage = "$($imageRepo):main"
if ($Tag) {
  if ($Tag -ne 'main') { $targetImage = "$($imageRepo):$Tag" }
}
elseif ($pinned) {
  if (-not $NurKontrolle) {
    throw "BACKEND_IMAGE ist fest auf $($pinned.value) gesetzt. Zurueck auf main mit -Tag main, oder gezielt mit -Tag <tag>."
  }
  $targetImage = $pinned.value
}

if ($NurKontrolle) {
  $null = Test-Deployment -Expected (Resolve-ExpectedRevision $targetImage)
}
else {
  if ($Tag) {
    $expected = Resolve-ExpectedRevision $targetImage
    $label = $Tag
  }
  else {
    Write-Step 'Stand pruefen'
    if (Invoke-Git status --porcelain) { throw 'Der Arbeitsstand ist nicht committet. Erst committen und pushen.' }
    Invoke-Git fetch origin main --quiet | Out-Null
    $head = [string](Invoke-Git rev-parse HEAD)
    $remoteHead = [string](Invoke-Git rev-parse origin/main)
    if ($head -ne $remoteHead) {
      throw "HEAD ($($head.Substring(0, 7))) ist nicht origin/main ($($remoteHead.Substring(0, 7))). Erst pushen bzw. auf main wechseln."
    }
    Write-Ok "HEAD $($head.Substring(0, 7)) ist auf origin/main"
    if (-not $OhneImage) { Wait-ImageBuild $head }
    $expected = Resolve-ExpectedRevision $targetImage
    $label = $head.Substring(0, 7)
  }

  $before = Get-DatabaseCounts
  Backup-Database $label

  $oldBackend = Get-ServiceContainer -Project $StackName -Service backend
  Invoke-Redeploy $targetImage
  $newImageId = Test-Deployment -Expected $expected -Before $before -OldBackendId $oldBackend.Id

  if ($script:failed) {
    Write-Warn 'Kontrolle nicht bestanden - das alte Image bleibt fuer einen Ruecksprung liegen.'
  }
  else {
    Remove-OldImage -OldImageId $oldBackend.ImageID -NewImageId $newImageId
  }
}

Write-Host ''
if ($script:failed) {
  Write-Host 'Kontrolle NICHT bestanden.' -ForegroundColor Red
  exit 1
}
Write-Host 'Alles in Ordnung.' -ForegroundColor Green
