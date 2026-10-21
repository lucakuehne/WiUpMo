# Steuerung des Docker-Servers ueber die Portainer-API, ohne lokales Docker.
#
# Zugangsdaten und Serveradresse liegen ausserhalb des Repositorys, beide sind
# per .gitignore und .dockerignore ausgeschlossen:
#
#   deploy/portainer-token.txt     API-Token (Portainer: My account -> Access tokens)
#   deploy/portainer.local.psd1    Adresse und Environment-Id, Vorlage: portainer.local.example.psd1
#
# Alle Aufrufe laufen ueber curl.exe aus Windows. Invoke-RestMethod aus Windows
# PowerShell 5.1 scheitert am TLS-Handshake mit dem selbstsignierten Zertifikat
# von Portainer.
#
# Diese Datei ist bewusst reines ASCII: PowerShell 5.1 liest UTF-8 ohne BOM als
# ANSI und verstuemmelt Umlaute.

$ErrorActionPreference = 'Stop'

$script:DeployDir = Split-Path -Parent $PSScriptRoot
$script:Curl = Join-Path $env:SystemRoot 'System32\curl.exe'
# Das tar von Windows (bsdtar), nicht das aus Git: Letzteres deutet C:\ als
# entfernten Rechner.
$script:Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$script:Utf8 = New-Object System.Text.UTF8Encoding $false
$script:Config = $null

function Get-PortainerConfig {
  if ($script:Config) { return $script:Config }

  $configPath = Join-Path $script:DeployDir 'portainer.local.psd1'
  $tokenPath = Join-Path $script:DeployDir 'portainer-token.txt'
  if (-not (Test-Path $configPath)) {
    throw "Es fehlt $configPath. Vorlage: deploy\portainer.local.example.psd1"
  }
  if (-not (Test-Path $tokenPath)) {
    throw "Es fehlt $tokenPath. Ein API-Token erzeugt Portainer unter My account -> Access tokens."
  }

  $data = Import-PowerShellDataFile $configPath
  $token = ([IO.File]::ReadAllText($tokenPath)).Trim()
  if (-not $token) { throw "$tokenPath ist leer." }

  $publicUrl = ''
  if ($data.ContainsKey('PublicUrl')) { $publicUrl = ([string]$data.PublicUrl).TrimEnd('/') }

  $script:Config = [pscustomobject]@{
    Url        = ([string]$data.Url).TrimEnd('/')
    EndpointId = [int]$data.EndpointId
    PublicUrl  = $publicUrl
    Token      = $token
  }
  $script:Config
}

function New-TempFile {
  [IO.Path]::GetTempFileName()
}

<#
  Ein Aufruf der Portainer-API.

  -Body      wird als JSON gesendet (Objekt oder fertige Zeichenkette)
  -InFile    sendet eine Datei roh, etwa ein tar
  -OutFile   schreibt die Antwort in eine Datei statt sie auszuwerten
  -Allow     weitere zulaessige Statuscodes, etwa 404 oder 409
  -Full      liefert Status und Text statt des ausgewerteten JSON
#>
function Invoke-Portainer {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('GET', 'POST', 'PUT', 'DELETE')][string]$Method,
    [Parameter(Mandatory, Position = 1)][string]$Path,
    $Body,
    [string]$InFile,
    [string]$ContentType = 'application/json',
    [string]$OutFile,
    [int[]]$Allow = @(),
    [int]$TimeoutSeconds = 300,
    [switch]$Full
  )

  $cfg = Get-PortainerConfig
  $headerFile = New-TempFile
  $responseFile = $OutFile
  if (-not $responseFile) { $responseFile = New-TempFile }
  $bodyFile = $null

  try {
    # Das Token geht ueber eine Datei an curl, nicht ueber die Befehlszeile:
    # Die ist fuer jeden Prozess auf dem Rechner lesbar.
    [IO.File]::WriteAllText($headerFile, "X-API-Key: $($cfg.Token)`n", $script:Utf8)

    $curlArgs = @('-sS', '-k', '-X', $Method, '-H', "@$headerFile",
      '-o', $responseFile, '-w', '%{http_code}', '--max-time', [string]$TimeoutSeconds)

    if ($null -ne $Body) {
      $json = $Body
      if ($Body -isnot [string]) { $json = ConvertTo-Json -InputObject $Body -Depth 20 -Compress }
      # Ueber eine Datei: PowerShell 5.1 verstuemmelt Anfuehrungszeichen in
      # Argumenten an native Programme.
      $bodyFile = New-TempFile
      [IO.File]::WriteAllText($bodyFile, $json, $script:Utf8)
      $curlArgs += @('-H', "Content-Type: $ContentType", '--data-binary', "@$bodyFile")
    }
    elseif ($InFile) {
      $curlArgs += @('-H', "Content-Type: $ContentType", '--data-binary', "@$InFile")
    }

    $curlArgs += "$($cfg.Url)$Path"
    $status = & $script:Curl @curlArgs
    if ($LASTEXITCODE -ne 0) { throw "curl $Method $Path ist gescheitert (Code $LASTEXITCODE)." }

    $code = [int]$status
    $text = ''
    if (-not $OutFile -and (Test-Path $responseFile)) {
      $text = [IO.File]::ReadAllText($responseFile, $script:Utf8)
    }

    $ok = ($code -ge 200 -and $code -lt 300) -or ($Allow -contains $code)
    if (-not $ok) {
      if ($OutFile -and (Test-Path $OutFile)) { $text = [IO.File]::ReadAllText($OutFile, $script:Utf8) }
      if ($text.Length -gt 2000) { $text = $text.Substring(0, 2000) + ' ...' }
      throw "$Method $Path -> $code $text"
    }

    if ($Full) { return [pscustomobject]@{ Status = $code; Text = $text } }
    if ($OutFile) { return }
    if ($text.Trim()) { return ($text | ConvertFrom-Json) }
  }
  finally {
    Remove-Item -LiteralPath $headerFile -Force -ErrorAction SilentlyContinue
    if ($bodyFile) { Remove-Item -LiteralPath $bodyFile -Force -ErrorAction SilentlyContinue }
    if (-not $OutFile) { Remove-Item -LiteralPath $responseFile -Force -ErrorAction SilentlyContinue }
  }
}

<# Die Docker-API des Servers, durchgereicht von Portainer. #>
function Invoke-Docker {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory, Position = 0)][ValidateSet('GET', 'POST', 'PUT', 'DELETE')][string]$Method,
    [Parameter(Mandatory, Position = 1)][string]$Path,
    $Body,
    [string]$InFile,
    [string]$ContentType = 'application/json',
    [string]$OutFile,
    [int[]]$Allow = @(),
    [int]$TimeoutSeconds = 300,
    [switch]$Full
  )
  $PSBoundParameters['Path'] = "/api/endpoints/$((Get-PortainerConfig).EndpointId)/docker$Path"
  Invoke-Portainer @PSBoundParameters
}

function ConvertTo-DockerFilter([hashtable]$Filter) {
  [uri]::EscapeDataString((ConvertTo-Json -InputObject $Filter -Compress))
}

<#
  Zerlegt den Ausgabestrom von Logs und Exec. Ohne TTY setzt Docker jedem
  Block acht Bytes voran: Kanal (1 = stdout, 2 = stderr), drei Nullbytes und
  die Laenge.
#>
function Read-DockerStream([string]$File) {
  $bytes = [IO.File]::ReadAllBytes($File)
  $framed = $bytes.Length -ge 8 -and $bytes[0] -le 2 -and $bytes[1] -eq 0 -and $bytes[2] -eq 0 -and $bytes[3] -eq 0
  if (-not $framed) {
    $all = $script:Utf8.GetString($bytes)
    return [pscustomobject]@{ Stdout = $all; Stderr = ''; Combined = $all }
  }

  $out = New-Object IO.MemoryStream
  $err = New-Object IO.MemoryStream
  $both = New-Object IO.MemoryStream
  $i = 0
  while ($i + 8 -le $bytes.Length) {
    $size = ([int]$bytes[$i + 4] -shl 24) -bor ([int]$bytes[$i + 5] -shl 16) -bor ([int]$bytes[$i + 6] -shl 8) -bor [int]$bytes[$i + 7]
    $start = $i + 8
    $length = [Math]::Min($size, $bytes.Length - $start)
    if ($bytes[$i] -eq 2) { $err.Write($bytes, $start, $length) } else { $out.Write($bytes, $start, $length) }
    $both.Write($bytes, $start, $length)
    $i = $start + $size
  }

  [pscustomobject]@{
    Stdout   = $script:Utf8.GetString($out.ToArray())
    Stderr   = $script:Utf8.GetString($err.ToArray())
    Combined = $script:Utf8.GetString($both.ToArray())
  }
}

<# Nest faerbt seine Ausgabe auch ohne Terminal; fuers Durchsuchen stoert das. #>
function Remove-AnsiColor([string]$Text) {
  $Text -replace "\x1b\[[0-9;]*m", ''
}

<# Container eines Compose-Projekts, wahlweise eines Dienstes. #>
function Find-Container {
  param(
    [Parameter(Mandatory)][string]$Project,
    [string]$Service,
    [switch]$All
  )
  $labels = @("com.docker.compose.project=$Project")
  if ($Service) { $labels += "com.docker.compose.service=$Service" }
  # Nicht $all nennen: PowerShell unterscheidet nicht nach Gross- und
  # Kleinschreibung, das ueberschriebe den Schalter.
  $includeStopped = 0
  if ($All) { $includeStopped = 1 }
  @(Invoke-Docker GET "/containers/json?all=$includeStopped&filters=$(ConvertTo-DockerFilter @{ label = $labels })")
}

<# Genau ein laufender Container eines Dienstes, sonst ein Fehler. #>
function Get-ServiceContainer {
  param([Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$Service, [switch]$All)
  $found = @(Find-Container -Project $Project -Service $Service -All:$All)
  if ($found.Count -eq 0) { throw "Kein Container fuer $Project/$Service gefunden." }
  if ($found.Count -gt 1) { throw "Mehrere Container fuer $Project/$Service gefunden." }
  $found[0]
}

function Get-ContainerInfo([Parameter(Mandatory)][string]$Container) {
  Invoke-Docker GET "/containers/$Container/json"
}

<#
  Zeitangabe von Docker als Unix-Zeit. Docker liefert Nanosekunden, .NET liest
  hoechstens sieben Nachkommastellen. PowerShell 7 wandelt die Zeichenkette
  schon beim Einlesen in ein Datum, 5.1 nicht.
#>
function ConvertTo-UnixTime($Value) {
  if ($Value -is [datetime]) { return ([DateTimeOffset]$Value).ToUnixTimeSeconds() }
  $text = ([string]$Value) -replace '(\.\d{7})\d+', '$1'
  [DateTimeOffset]::Parse($text, [Globalization.CultureInfo]::InvariantCulture).ToUnixTimeSeconds()
}

function Get-ContainerStartTime([Parameter(Mandatory)][string]$Container) {
  ConvertTo-UnixTime (Get-ContainerInfo $Container).State.StartedAt
}

<#
  Fuehrt einen Befehl in einem Container aus und liefert ExitCode, Stdout und
  Stderr. Ein Exit-Code ungleich 0 ist ein Fehler, ausser mit -AllowFailure.
#>
function Invoke-DockerExec {
  param(
    [Parameter(Mandatory)][string]$Container,
    [Parameter(Mandatory)][string[]]$Command,
    [string]$User,
    [string]$WorkingDir,
    [string[]]$Env,
    [int]$TimeoutSeconds = 600,
    [switch]$AllowFailure
  )

  $create = @{ AttachStdout = $true; AttachStderr = $true; Tty = $false; Cmd = $Command }
  if ($User) { $create.User = $User }
  if ($WorkingDir) { $create.WorkingDir = $WorkingDir }
  if ($Env) { $create.Env = $Env }
  $exec = Invoke-Docker POST "/containers/$Container/exec" -Body $create

  $outFile = New-TempFile
  try {
    Invoke-Docker POST "/exec/$($exec.Id)/start" -Body @{ Detach = $false; Tty = $false } -OutFile $outFile -TimeoutSeconds $TimeoutSeconds
    $streams = Read-DockerStream $outFile
  }
  finally {
    Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
  }

  # Der Strom endet mit dem Prozess; der Exit-Code steht trotzdem nicht immer
  # sofort fest.
  for ($try = 0; $try -lt 20; $try++) {
    $info = Invoke-Docker GET "/exec/$($exec.Id)/json"
    if (-not $info.Running) { break }
    Start-Sleep -Milliseconds 250
  }

  $result = [pscustomobject]@{ ExitCode = $info.ExitCode; Stdout = $streams.Stdout; Stderr = $streams.Stderr }
  if ($result.ExitCode -ne 0 -and -not $AllowFailure) {
    $short = $Container.Substring(0, [Math]::Min(12, $Container.Length))
    throw "Befehl in Container $short endete mit $($result.ExitCode): $($Command -join ' ')`n$($result.Stderr)$($result.Stdout)"
  }
  $result
}

<# Protokoll eines Containers ohne Farbcodes, wahlweise ab einer Unix-Zeit. #>
function Get-ContainerLog {
  param([Parameter(Mandatory)][string]$Container, [long]$Since = 0, [int]$Tail = 0)
  $query = 'stdout=1&stderr=1'
  if ($Since -gt 0) { $query += "&since=$Since" }
  if ($Tail -gt 0) { $query += "&tail=$Tail" }

  $file = New-TempFile
  try {
    Invoke-Docker GET "/containers/$Container/logs?$query" -OutFile $file
    Remove-AnsiColor (Read-DockerStream $file).Combined
  }
  finally {
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
}

function Wait-ContainerLog {
  param(
    [Parameter(Mandatory)][string]$Container,
    [Parameter(Mandatory)][string]$Pattern,
    [long]$Since = 0,
    [int]$TimeoutSeconds = 180
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if ((Get-ContainerLog -Container $Container -Since $Since) -match $Pattern) { return $true }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  $false
}

<# Wartet auf den Healthcheck aus der Compose-Datei. #>
function Wait-ContainerHealthy {
  param([Parameter(Mandatory)][string]$Container, [int]$TimeoutSeconds = 180)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $state = (Get-ContainerInfo $Container).State
    if ($state.Status -ne 'running') { throw "Container laeuft nicht (Zustand $($state.Status), Exit-Code $($state.ExitCode))." }
    if ($state.Health -and $state.Health.Status -eq 'healthy') { return }
    Start-Sleep -Seconds 3
  } while ((Get-Date) -lt $deadline)
  throw "Container wurde nicht innerhalb von $TimeoutSeconds s gesund."
}

<#
  Wartet, bis ein einmaliger Container (migrate) einen neuen Lauf beendet hat,
  und liefert dessen Exit-Code. Verglichen wird mit dem Ende des vorigen Laufs
  statt mit der Uhr des Laptops - die geht nicht unbedingt gleich wie die des
  Servers.
#>
function Wait-ContainerExit {
  param([Parameter(Mandatory)][string]$Container, [string]$PreviousFinish = '', [int]$TimeoutSeconds = 300)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $state = (Get-ContainerInfo $Container).State
    if ($state.Status -eq 'exited' -and [string]$state.FinishedAt -ne $PreviousFinish) { return [int]$state.ExitCode }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "Container hat sich nicht innerhalb von $TimeoutSeconds s beendet."
}

<#
  Legt lokale Dateien in ein Verzeichnis eines Containers. Das Verzeichnis
  muss bestehen. Zeilenenden werden bei Textdateien auf LF gestellt, sonst
  scheitert ein Shell-Skript an einem Checkout mit CRLF.
#>
function Send-ContainerFile {
  param(
    [Parameter(Mandatory)][string]$Container,
    [Parameter(Mandatory)][string]$TargetDir,
    [Parameter(Mandatory)][string[]]$Path
  )
  $stage = Join-Path ([IO.Path]::GetTempPath()) ('wiupmo-' + [guid]::NewGuid())
  $tarFile = "$stage.tar"
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    foreach ($file in $Path) {
      $target = Join-Path $stage (Split-Path -Leaf $file)
      if ($file -match '\.(sh|mjs|js|ldif|json)$') {
        $text = [IO.File]::ReadAllText((Resolve-Path $file).ProviderPath, $script:Utf8) -replace "`r`n", "`n"
        [IO.File]::WriteAllText($target, $text, $script:Utf8)
      }
      else {
        Copy-Item -LiteralPath $file -Destination $target
      }
    }
    & $script:Tar -cf $tarFile -C $stage .
    if ($LASTEXITCODE -ne 0) { throw 'tar ist gescheitert.' }
    Invoke-Docker PUT "/containers/$Container/archive?path=$([uri]::EscapeDataString($TargetDir))" -InFile $tarFile -ContentType 'application/x-tar' | Out-Null
  }
  finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tarFile -Force -ErrorAction SilentlyContinue
  }
}

<# Holt ein Verzeichnis aus einem Container und entpackt es lokal. #>
function Receive-ContainerFile {
  param(
    [Parameter(Mandatory)][string]$Container,
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$Destination
  )
  $tarFile = New-TempFile
  try {
    Invoke-Docker GET "/containers/$Container/archive?path=$([uri]::EscapeDataString($SourcePath))" -OutFile $tarFile -TimeoutSeconds 600
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & $script:Tar -xf $tarFile -C $Destination
    if ($LASTEXITCODE -ne 0) { throw 'Entpacken ist gescheitert.' }
  }
  finally {
    Remove-Item -LiteralPath $tarFile -Force -ErrorAction SilentlyContinue
  }
}

function Get-PortainerStack([Parameter(Mandatory)][string]$Name) {
  @(Invoke-Portainer GET '/api/stacks') | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
}

<#
  Baut ein Image auf dem Server aus einem tar des Build-Kontexts. Der
  Build-Endpunkt arbeitet mit dem klassischen Builder, deshalb verzichtet das
  Dockerfile auf BuildKit-Eigenheiten.
#>
function Invoke-DockerBuild {
  param(
    [Parameter(Mandatory)][string]$ContextTar,
    [Parameter(Mandatory)][string]$Tag,
    [string]$Dockerfile = 'Dockerfile',
    [hashtable]$Labels = @{},
    [int]$TimeoutSeconds = 2400
  )
  $query = "t=$([uri]::EscapeDataString($Tag))&dockerfile=$([uri]::EscapeDataString($Dockerfile))&rm=1&forcerm=1"
  if ($Labels.Count -gt 0) { $query += "&labels=$(ConvertTo-DockerFilter $Labels)" }

  $out = New-TempFile
  try {
    Invoke-Docker POST "/build?$query" -InFile $ContextTar -ContentType 'application/x-tar' -OutFile $out -TimeoutSeconds $TimeoutSeconds
    $stream = New-Object Collections.Generic.List[string]
    $failure = $null
    foreach ($line in [IO.File]::ReadAllLines($out, $script:Utf8)) {
      if (-not $line.Trim()) { continue }
      try { $message = $line | ConvertFrom-Json } catch { continue }
      if ($message.PSObject.Properties['error']) { $failure = $message.error }
      if ($message.PSObject.Properties['stream'] -and $message.stream.Trim()) { $stream.Add($message.stream.TrimEnd()) }
    }
    if ($failure) {
      $tail = ($stream | Select-Object -Last 30) -join "`n"
      throw "Build gescheitert: $failure`n$tail"
    }
    $stream | Select-Object -Last 3
  }
  finally {
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  }
}

<#
  Entfernt ein Image, aber nie mit Gewalt: Benutzt es noch ein Container,
  lehnt Docker ab, und das Image bleibt. Liefert den Statuscode.
#>
function Remove-DockerImage([Parameter(Mandatory)][string]$Reference) {
  (Invoke-Docker DELETE "/images/$Reference" -Allow 404, 409 -Full).Status
}

<# Entfernt die Volumes eines Test-Projekts. Fuer produktive Stacks gesperrt. #>
function Remove-ProjectVolume([Parameter(Mandatory)][string]$Project) {
  if ($Project -notmatch '-test$') { throw "Volumes von '$Project' werden nicht angefasst - nur Test-Stacks (*-test)." }
  $list = Invoke-Docker GET "/volumes?filters=$(ConvertTo-DockerFilter @{ label = @("com.docker.compose.project=$Project") })"
  foreach ($volume in @($list.Volumes)) {
    if ($null -eq $volume) { continue }
    $status = (Invoke-Docker DELETE "/volumes/$($volume.Name)" -Allow 404, 409 -Full).Status
    if ($status -eq 409) { Write-Warning "Volume $($volume.Name) ist noch in Benutzung." }
  }
}

Export-ModuleMember -Function *
