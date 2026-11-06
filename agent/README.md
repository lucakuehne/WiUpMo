# Agent

.NET 10 Windows-Dienst, der den Windows-Update-Status des Rechners liest, offline
puffert und an das Backend meldet.

## Installation

Die EXE gibt es fertig im Backend: **Agents → Versionen**, dort das
Download-Symbol in der gewünschten Zeile. Sie wird mit dem Backend-Image
ausgeliefert und beim Start aufgenommen — selbst bauen muss man dafür nichts.

Ein einzelner Aufruf, unabhängig von jeder Verteilungslösung — verteilbar per
GPO-Startskript, von Hand oder über ein beliebiges Werkzeug:

```powershell
# Als Administrator, im Verzeichnis der heruntergeladenen Datei:
.\wiupmo-agent-0.4.0.exe --install `
  --backend-url https://wium.intern:3000 `
  --enrollment-token <Wert aus den Einstellungen>
```

Selbst übersetzen geht weiterhin, etwa für eine Vorabversion:

```powershell
dotnet publish agent/src/WiUpMo.Agent/WiUpMo.Agent.csproj -c Release -r win-x64 -o agent/publish
```

Das richtet ein:

| | |
|---|---|
| Programm | `%ProgramFiles%\WiUpMo\versions\<Version>\wiupmo-agent.exe`; daneben im Programmverzeichnis `appsettings.json` und die Updater-Kopie `wiupmo-updater.exe` |
| Dienst | `WiUpMoAgent`, Start **Automatisch (Verzögert)**, Konto `LocalSystem` |
| Wiederherstellung | Neustart nach 1 min / 2 min / danach alle 10 min, Zähler-Reset nach einem Tag |
| Daten | `%ProgramData%\WiUpMo` mit den von `%ProgramData%` geerbten Rechten |
| Ereignisquelle | `WiUpMo Agent` im Anwendungsprotokoll |

`--install` auf einem bereits eingerichteten Rechner hält den Dienst an, legt
die Version unter `versions\` ab, stellt den Dienst darauf um und startet ihn
wieder. Eine Installation vom alten Ort (vor 0.8.0) zieht dabei um.

### Deinstallation

```powershell
# Als Administrator, mit der Updater-Kopie — sie ist dieselbe EXE
& "$env:ProgramFiles\WiUpMo\wiupmo-updater.exe" --uninstall

# Restlos, samt Identität und Protokollen
& "$env:ProgramFiles\WiUpMo\wiupmo-updater.exe" --uninstall --purge
```

`--uninstall` entfernt den geplanten Task, den Dienst, die Ereignisquelle und das
Programmverzeichnis. Das Datenverzeichnis bleibt bewusst stehen: Dort liegt die
Geräteidentität, und eine erneute Installation ist damit wieder **dasselbe**
Gerät statt eines zweiten Eintrags im Backend. `--purge` entfernt es mit.

Die gerade laufende EXE kann sich nicht selbst löschen — ruft man die
Deinstallation mit der installierten Datei auf, bleibt genau diese liegen. Der
Aufruf sagt dann, mit welchem Befehl der Rest wegkommt.

Im Backend bleibt das Gerät bestehen und fällt nach einigen Tagen unter „meldet
sich nicht mehr". Wer das vermeiden will, archiviert es dort von Hand.

> Das Konto `LocalSystem` ist nicht verhandelbar: WUApi und die
> Richtlinien-Registrierungsschlüssel sind für normale Benutzer nicht lesbar.

## Betriebsarten

| Aufruf | Verhalten |
|---|---|
| *(ohne Argumente)* | Dauerlauf im Vordergrund — praktisch zum Beobachten |
| `--once` | Ein Durchlauf, dann beenden. Zum Prüfen einer Installation. |
| `--install` / `--uninstall` | Dienst und Updater-Task einrichten bzw. entfernen (Administratorrechte) |
| `--uninstall --purge` | Zusätzlich das Datenverzeichnis mit Identität, Warteschlange und Protokollen |
| `--updater` | Ein Updater-Lauf. Wird vom geplanten Task aufgerufen, nicht von Hand. |
| `--install-probe` | Geht den Installationsweg bis vor Download und Installation: zeigt die angebotenen Updates und ob Windows bereit ist. Installiert nichts. |

> `--once` greift auf dieselbe Warteschlange zu wie der Dienst. Läuft der
> Dienst, sind zwei gleichzeitige Durchläufe zwar unschädlich — SQLite
> serialisiert die Schreibzugriffe —, aber unnötig. Zum Prüfen genügt ein Blick
> ins Protokoll.

Im Dienstbetrieb läuft ein Durchlauf:

- **im zentral eingestellten Abstand** (Voreinstellung 5 Minuten, mindestens 2)
  — der Wert kommt aus den Einstellungen des Backends und geht mit jeder
  Check-in-Antwort mit; `CheckIntervalMinutes` (ebenfalls 5 Minuten) ist nur
  der Rückfall, bis sich das Gerät zum ersten Mal gemeldet hat,
- **einmalig 90 Sekunden nach Dienststart** (`StartupDelaySeconds`) — nicht
  sofort, weil eine Update-Suche während des Systemhochlaufs mit allem anderen um
  Platte und Netz konkurriert,
- **bei Netzwerkwechseln**, entprellt auf mindestens 5 Minuten Abstand
  (`NetworkDebounceMinutes`).

Der Netzwerk-Trigger ist der Grund, warum es ein Dienst ist und keine geplante
Aufgabe: Baut ein Laptop das VPN auf, sollen die gepufferten Meldungen sofort
nachgereicht werden statt bis zum nächsten Intervall zu warten. Die Entprellung
ist dabei kein Detail — ein einzelner VPN-Aufbau erzeugt eine ganze Reihe von
Ereignissen, und ohne Mindestabstand liefe der Agent mehrfach hintereinander los.

## Ablauf eines Durchlaufs

1. WUApi-Suche `IsInstalled=0 and IsHidden=0`
2. `QueryHistory` seit dem letzten gemeldeten Zeitstempel
3. Ab 0.8.2, nur wenn die Historie Neues meldet oder es einen Tag her ist:
   WUApi-Suche `IsInstalled=1` ohne Verbindung zur Update-Quelle. Die
   installierten Updates gehen mit Typ und Einstufung mit, sofern sich ihre
   Menge geändert hat — die Historie selbst nennt nur das Produkt
4. Update-Quelle, Richtlinien, Neustart-Status und zuletzt angemeldeten Benutzer
   erfassen (`LogonUI\LastLoggedOnUser` in der Registry, ab 0.7.1), dazu den
   letzten Neustart (Laufzeit seit dem Systemstart, ab 0.8.0)
5. Snapshot mit `snapshotId` und `collectedAt` (UTC) in die SQLite-Warteschlange
6. Gesamte Warteschlange per `/checkin/batch` senden
7. Quittierte Snapshots löschen — auch abgelehnte, die werden durch Wiederholen
   nicht besser und blockierten die Warteschlange sonst dauerhaft

Erfassen und Senden sind getrennt. Nach Schritt 5 liegt der Snapshot dauerhaft
vor; ob das Backend gerade erreichbar ist, spielt für die Erfassung keine Rolle
mehr. Genau das macht den Offline-Betrieb aus.

## Konfiguration

Drei Quellen, die einander in dieser Reihenfolge überschreiben:

1. `appsettings.json` neben der EXE
2. Umgebungsvariablen mit Präfix `WIUPMO_`, z. B. `WIUPMO_Agent__BackendUrl`
3. Aufrufparameter

| Schlüssel | Aufrufparameter | Standard | Bedeutung |
|---|---|---|---|
| `Agent:BackendUrl` | `--backend-url` | — | Basisadresse des Backends. Pflicht. |
| `Agent:EnrollmentToken` | `--enrollment-token` | — | Nur bis zur erstmaligen Registrierung nötig. |
| `Agent:DataDirectory` | `--data-directory` | `%ProgramData%\WiUpMo` | |
| `Agent:CheckIntervalMinutes` | `--interval-minutes` | 5 | Abstand regulärer Durchläufe. Wird vom Wert aus den Backend-Einstellungen überstimmt, sobald einer vorliegt. |
| `Agent:StartupDelaySeconds` | — | 90 | Wartezeit nach Dienststart. |
| `Agent:NetworkDebounceMinutes` | — | 5 | Mindestabstand netzwerkausgelöster Durchläufe. |
| `Agent:QueueMaxSnapshots` | — | 200 | Obergrenze der Warteschlange. |
| `Agent:QueueMaxAgeDays` | — | 30 | Höchstalter in der Warteschlange. |
| `Agent:SearchOnline` | `--search-online` | true | `false` liest nur den lokalen Zwischenspeicher. |
| `Agent:ComTimeoutSeconds` | — | 300 | Obergrenze pro WUApi-Aufruf. |
| `Agent:InstallTimeoutMinutes` | — | 180 | Obergrenze für einen Installationsauftrag, Download und Installation zusammen. |
| `Agent:UpdateVerificationMinutes` | — | 20 | Frist, in der sich eine neue Fassung bestätigen muss, sonst stellt der Updater zurück. |
| `Agent:SimulateWindowsUpdate` | — | false | **Nur für den Ende-zu-Ende-Test:** fragt Windows Update nicht ab. Im Betrieb nie setzen. |
| `Agent:SimulateRestart` | — | false | **Nur für den Ende-zu-Ende-Test:** startet nicht neu, sondern legt `restart-simulated.txt` ab, und behandelt das Gerät als Arbeitsplatz, an dem niemand angemeldet ist — der Runner ist ein Windows Server. Im Betrieb nie setzen. |
| `Agent:InitialHistoryDays` | — | 90 | Rückblick beim allerersten Check-in. |
| `Agent:LogRetentionDays` | — | 14 | Aufbewahrung der Protokolldateien. |

## Ablage auf dem Gerät

Unter `%ProgramData%\WiUpMo`:

| Datei | Inhalt |
|---|---|
| `identity.dat` | Geräte-ID und Secret, mit DPAPI im Maschinenkontext verschlüsselt |
| `queue.db` | Offline-Warteschlange und Fortschrittsmarker der Historie |
| `install.json` | Stand eines Installationsauftrags, bis das Backend das Ergebnis hat |
| `restart.json` | Stand eines Neustart-Auftrags: Frist, Verschiebungen, noch nicht gemeldete Rückmeldungen |
| `update.json` | Stand eines Selbst-Updates, geteilt zwischen Dienst und Updater |
| `logs\agent-*.log` | Tagesrotierendes Protokoll des Dienstes |
| `logs\updater-*.log` | Protokoll des Updaters, nur wenn er etwas zu tun hatte |

Geht `identity.dat` verloren, registriert sich der Agent neu. Das Backend erkennt
das Gerät am Hostnamen wieder, die Historie bleibt erhalten.

Der Fortschrittsmarker liegt bewusst **in** `queue.db` und wird in derselben
Transaktion fortgeschrieben wie der Snapshot. Läge er daneben, könnte ein
Absturz zwischen beiden Schreibvorgängen dazu führen, dass Historieneinträge ein
zweites Mal gemeldet werden — und weil `device_update_events` im Backend rein
anhängend ist, entstünden daraus doppelte Ereignisse in der Zeitreihe.

## Protokollierung

Rollierende Tagesdatei unter `%ProgramData%\WiUpMo\logs\`. Zusätzlich gehen im
Dienstbetrieb **Warnungen und Fehler** ins Windows-Anwendungsprotokoll (Quelle
`WiUpMo Agent`). Bewusst nur diese: Das Ereignisprotokoll ist der Ort, an dem
ein Administrator nachsieht, der vom Agent nichts weiss — mit jedem
Vier-Stunden-Durchlauf vollgeschrieben wäre es dafür wertlos.

## Rückgabewerte

| Wert | Bedeutung |
|---|---|
| 0 | Erfolgreich beendet |
| 1 | Fehler |
| 2 | Konfigurationsfehler bzw. fehlende Administratorrechte bei `--install` |

## Aufbau

| Datei | Aufgabe |
|---|---|
| `Program.cs` | Kommandos, Host, Serilog, Abhängigkeiten |
| `Worker.cs` | Dienstschleife: Intervall, Trigger, Fehlerbehandlung |
| `AgentCycle.cs` | Ein Durchlauf: erfassen, ablegen, übermitteln |
| `CheckinTrigger.cs` | Netzwerkereignisse mit Entprellung |
| `SnapshotCollector.cs` | Setzt den Snapshot aus den Einzelteilen zusammen |
| `Storage/SnapshotQueue.cs` | SQLite-Warteschlange und Fortschrittsmarker |
| `Storage/DeviceIdentityStore.cs` | Identität (DPAPI) |
| `Install/ServiceInstaller.cs` | `--install` / `--uninstall` |
| `Windows/Com.cs` | Späte Bindung an COM über IDispatch |
| `Windows/WindowsUpdateReader.cs` | Offene Updates und Installationshistorie |
| `Windows/WindowsUpdateInstaller.cs` | Suchen, Lizenz annehmen, herunterladen, installieren |
| `Installation/InstallJobRunner.cs` | Installationsaufträge annehmen, im Hintergrund ausführen, melden |
| `Installation/InstallMarker.cs` | Stand eines Auftrags in `install.json` |
| `Windows/UpdateSourceInspector.cs` | WSUS / Microsoft Update / Intune / Dual Scan |
| `Windows/HostInspector.cs` | Stammdaten und Neustart-Status |
| `Backend/BackendClient.cs` | HTTP gegen `/api/agent/v1/...` |
| `Contracts/` | Gegenstücke zu den Backend-DTOs, gemeinsame JSON-Einstellungen |

### Warum späte Bindung statt `COMReference`

Der typisierte Weg über `<COMReference>` scheidet aus: die MSBuild-Aufgabe
`ResolveComReference` gibt es nur im .NET-Framework-MSBuild aus Visual Studio,
nicht unter `dotnet build`. Das wäre eine Visual-Studio-Abhängigkeit für jeden
Build und jede CI.

Innerhalb der späten Bindung fiel die Wahl auf `Type.InvokeMember` statt
`dynamic` — der Aufruf ist damit eindeutig, vor allem bei indizierten
Eigenschaften wie `Item`, und das Publish zieht den C#-Laufzeitbinder nicht mit.

## Selbst-Update

Ab 0.8.0 liegt jede Version in einem eigenen Verzeichnis, und ein Update stellt
den Dienst nur noch um:

```
C:\Program Files\WiUpMo\
  appsettings.json          gemeinsame Einstellungen aller Versionen
  wiupmo-updater.exe        Kopie, die umstellt und notfalls zurückstellt
  versions\0.8.0\wiupmo-agent.exe
  versions\0.8.1\wiupmo-agent.exe   ← binPath des Dienstes
```

Umgestellt wird per `sc config binPath`. Es werden keine Dateien mehr
getauscht: Eine gesperrte Datei, ein halber Tausch oder ein Virenscanner, der
die neue EXE gerade liest, können nichts mehr kaputt machen. Die vorige Version
bleibt unangetastet daneben liegen; der Rücktausch ist nur der Pfad zurück.
Nach einer bestätigten Umstellung bleiben die laufende und die vorige Version,
alles Ältere wird entfernt.

Der Updater ist eine **Kopie** (`wiupmo-updater.exe`), weil er den Dienst
anhalten muss und dabei nicht selbst der Dienst sein kann. Er läuft auf zwei
Wegen als SYSTEM:

- **sofort**: Der Dienst startet ihn, sobald die neue Fassung bereitliegt;
- **alle 5 Minuten** über den geplanten Task `WiUpMo Agent Updater` — als
  Rückfall und als Wächter, der eine nicht bestätigte Fassung zurücknimmt.

Ein globaler Mutex sorgt dafür, dass nie zwei Updater gleichzeitig arbeiten.
Netzwerkzugriff hat der Updater keinen.

### Ablauf

Dienst und Updater reden ausschliesslich über `%ProgramData%\WiUpMo\update.json`
miteinander.

| Zustand | Wer handelt | Was passiert |
|---|---|---|
| — | Dienst | Auftrag in der Check-in-Antwort: Binary nach `versions\<Version>\` laden, SHA-256 prüfen, Marker `pendingSwap` mit Ziel- und Herkunftspfad, `installing` melden, Updater starten |
| `pendingSwap` | Updater | Dienst anhalten, Marker `verifying` mit Frist (20 min), `binPath` auf die neue EXE, Dienst starten. Startet sie nicht: sofort zurück |
| `verifying` | Dienst | Nach dem **ersten vollständigen Durchlauf** in der Zielversion: Marker `verified` |
| `verifying`, Frist abgelaufen | Updater | `binPath` zurück, Dienst starten, Marker `rolledBack` mit Begründung |
| `verified` / `rolledBack` | Dienst | Ergebnis ans Backend melden, Marker entfernen, aufräumen, Updater-Kopie nachziehen |

### Regeln, die aus Fehlern im Feld kommen

- **Der Dienst wird nie angehalten zurückgelassen.** Ein Fehler zwischen
  Anhalten und Starten ließ ein Gerät früher verstummen, bis jemand von Hand
  eingriff. Jeder Ausgang des Updaters startet den Dienst wieder.
- **Kurze Sperren werden ausgesessen.** Dateioperationen werden bis zu 30
  Sekunden lang wiederholt; ein Schritt höchstens sechsmal, dann wird mit dem
  letzten Fehler als Grund aufgegeben.
- **Der Updater schreibt ein eigenes Protokoll** (`logs\updater-*.log`). Die
  Aufgabenplanung zeichnet die Konsole nicht auf; ein gescheiterter Tausch
  hinterließ früher keine Spur. Warnungen und Fehler daraus gehen mit der
  Selbstauskunft ans Backend und stehen im Agent-Protokoll als „Updater: …“.
- **Bestätigt wird nach dem ersten Durchlauf, nicht beim Start.** Eine
  Fassung, die startet, aber im Durchlauf scheitert, nimmt der Updater zurück.
  Solange eine Bestätigung aussteht, entfällt die Startverzögerung.
- **Die Updater-Kopie wird nachgezogen.** Bis 0.8.0 blieb sie auf dem Stand der
  Installation, und ihre Fehler waren nicht zu beheben. Jetzt ersetzt eine
  bestätigte neuere Version sie — nur aufwärts, und nur unter dem Mutex.
- **Die Selbstauskunft enthält den Task**: eingeschaltet, letzter Lauf,
  Ergebnis. Fehlt er oder scheitert er, steht das im Gerätedetail.

### Übergang von älteren Versionen

Geräte vor 0.8.0 haben die EXE im Programmverzeichnis und einen Updater, der
nur Dateien tauschen kann. Der Dienst nutzt den neuen Weg deshalb nur, wenn
die Updater-Kopie ihn beherrscht (ab 0.8.0). Ein älterer Updater fände die
bereitgelegte Datei nicht am alten Ort und würde den Auftrag verwerfen.

Das Update **auf** 0.8.0 läuft also noch als Dateitausch durch den alten
Updater. Danach zieht 0.8.0 die Updater-Kopie nach, und ab dem nächsten Update
gilt der neue Weg — dabei zieht der Dienst in `versions\` um. Der Updater ab
0.8.0 beherrscht den alten Dateitausch weiterhin, mit denselben Regeln wie
oben, etwa nach einem Rücktausch auf eine ältere Version. `--install` legt
neue Installationen gleich unter `versions\` an und stellt bestehende um.

### Warum `verified` ein eigener Zustand ist

Die lokale Bestätigung ist bewusst vom Melden ans Backend getrennt. Wäre sie es
nicht, würde ein unerreichbares Backend dazu führen, dass der Updater nach
Ablauf der Frist eine einwandfrei laufende neue Version zurückdreht — bei einem
Laptop im Homeoffice der Normalfall, nicht die Ausnahme. Der Dienst setzt
`verified` deshalb ohne jeden Netzwerkzugriff, und der Updater lässt ab diesem
Zustand die Finger davon.

### Der Task auf Notebooks

Bis 0.7.1 legte `--install` den Task mit `schtasks /SC MINUTE` an. Damit
übernimmt er die Voreinstellungen der Aufgabenplanung: Er startet nicht im
Akkubetrieb, und ein Lauf, der in den Ruhezustand fällt, wird nicht
nachgeholt. Auf Notebooks blieben Selbst-Updates deshalb in `pendingSwap`
stehen, bis der Dienst sie nach zwei Stunden aufgab („Vermutlich läuft der
Updater-Task nicht“). Am Netzteil tauschte derselbe Updater in Minuten.

Ab 0.7.2:

- Der Task entsteht aus einer XML-Definition (`Install/UpdaterTask.cs`): läuft
  auch am Akku, holt verpasste Läufe nach (`StartWhenAvailable`), höchstens
  30 Minuten je Lauf, keine zweite Instanz.
- Der Dienst prüft den Task bei jedem Start und ersetzt ihn, wenn er fehlt
  oder noch die alten Bedingungen hat. Installationen von vor 0.7.2 werden so
  ohne erneutes `--install` korrigiert.
- Ein überfälliger Marker (älter als zwei Stunden) wird erst aufgegeben, wenn
  der laufende Dienst ihn in sechs Durchläufen gesehen hat. Nach dem
  Aufwachen bekommt der Task so zuerst seine Gelegenheit.

Geräte mit älterem Agent brauchen dafür **einen** erfolgreichen Tausch nach
den alten Regeln: wach und am Netzteil, bis der Task gelaufen ist.

### Bei einer nicht passenden Prüfsumme

wird abgebrochen, nicht getauscht. Eine Datei unbekannter Herkunft als Dienst
unter `LocalSystem` zu starten wäre der schlimmste denkbare Ausgang dieses
Vorgangs.

## Ende-zu-Ende-Test

Das Selbst-Update lässt sich nur auf echtem Windows prüfen: als Dienst, mit
geplantem Task, mit Dateisperren und Virenscanner. Der Workflow
`.github/workflows/agent-e2e.yml` tut das auf einem Windows-Runner von GitHub,
bei jeder Änderung unter `agent/` und von Hand.

Er baut drei Fassungen aus dem aktuellen Stand — A, B und eine absichtlich
defekte C (`-p:WiUpMoE2EBroken=true`, nur beim Bauen setzbar) — und eine alte
aus dem Feld (0.6.0, Commit `2c66f06`). `e2e/run-e2e.ps1` spielt dann gegen
ein Test-Backend (`e2e/fake-backend.mjs`) durch:

| Schritt | Geprüft |
|---|---|
| Alte Fassung installieren | Dienst am alten Ort, Check-in |
| Update auf A | Dateitausch durch den alten Updater, Updater-Kopie nachgezogen, Task läuft auch am Akku |
| Update auf B | Umstellen per `binPath` nach `versions\`, vorige Fassung bleibt, Updater-Protokoll |
| Update auf C (defekt) | bestätigt sich nicht, wird nach der Frist zurückgenommen, `failed` mit Begründung |
| Deinstallation, Neuinstallation von A | gleich unter `versions\`, nichts am alten Ort, neue Registrierung |
| Neustart auf Anforderung | simuliert: ohne angemeldeten Benutzer sofort, `restarting` gemeldet, Auftrag abgelegt |

Die Protokolle von Agent und Updater, `sc qc`, die Task-Definition und der
Zustand des Test-Backends hängen am Lauf als Artefakt `agent-e2e`.

Für den Test setzt das Skript vier Einstellungen in die `appsettings.json`:
keine Startverzögerung, `SimulateWindowsUpdate`, `SimulateRestart` und eine
Bestätigungsfrist von 2 Minuten. Die Meldung beim Benutzer prüft der Test nicht —
auf dem Runner ist niemand angemeldet; dafür gibt es die Vorschau (siehe unten). Echte Update-Installationen prüft der Test nicht — dafür braucht es
ein Gerät mit offenen Updates.

## Installationsaufträge

Ab 0.7.0 installiert der Agent offene Updates auf Auftrag aus der Oberfläche.
Der Auftrag kommt wie das Selbst-Update mit der Check-in-Antwort
(`installRequest`), und zwar erst ab dem gewählten Zeitpunkt — was ankommt, ist
fällig.

Installiert wird über Windows Update aus der Quelle des Geräts. Der Agent sucht
unmittelbar davor noch einmal und nimmt nur, was Windows dann anbietet; am WSUS
also nur Freigegebenes. **Neu gestartet wird nie.** Verlangt ein Update einen
Neustart, steht das im Ergebnis und im nächsten Snapshot.

| Schritt | Was passiert |
|---|---|
| Annehmen | Nur, wenn kein anderer Auftrag läuft, kein Selbst-Update ansteht und Windows nicht selbst installiert. Sonst bleibt der Auftrag im Backend „zugestellt" und kommt beim nächsten Check-in wieder. |
| Neustart ausstehend | Verlangt Windows vor weiteren Installationen einen Neustart, scheitert der Auftrag sofort mit dieser Begründung. |
| Start | `install.json` anlegen, `running` melden. Antwortet das Backend mit 404 — inzwischen abgebrochen —, wird nicht installiert. |
| Ausführen | Im Hintergrund: suchen, Lizenz annehmen, herunterladen, installieren (`AllowSourcePrompts` aus, `ForceQuiet` an). Zeitlimit `InstallTimeoutMinutes`. |
| Melden | `done`, wenn alles Angebotene installiert ist, sonst `failed` — mit dem Ergebnis je Update. Danach sofort ein Durchlauf, damit der neue Stand im Backend steht. |

Während einer Installation sucht der Agent nicht — die Suche wartete auf Windows
und liefe ins Zeitlimit —, meldet aber weiter. Ein Selbst-Update wartet bis zum
Ende.

`install.json` ist der Grund, warum kein Auftrag verloren geht: Wird der Dienst
mittendrin beendet, meldet er ihn beim nächsten Start als unterbrochen. Ist das
Backend beim Abschluss nicht erreichbar, holt der nächste Durchlauf die Meldung
nach.

Vor dem ersten Auftrag auf einem Gerät zeigt `wiupmo-agent.exe --install-probe`
(als Administrator), ob der Weg trägt. Mit `--once` bleibt der Prozess bis zum
Ende einer angenommenen Installation offen.


## Neustart auf Anforderung

Ab 0.9.0 startet der Agent auf Anforderung aus der Oberfläche neu — für ein Gerät
oder eine Auswahl, nie für Server. Der Auftrag kommt mit der Check-in-Antwort
(`restartRequest`) samt den Regeln, nach denen der Benutzer verschieben darf; sie
stehen unter Einstellungen → Betrieb und gelten so, wie sie beim Anlegen waren.

| Lage | Was passiert |
|---|---|
| Niemand angemeldet | Sofort neu starten. |
| Angemeldet, Sitzung getrennt | Dort lässt sich nichts zeigen. Die Frist läuft; die Meldung kommt, sobald jemand zurück ist, an ihrem Ende wird neu gestartet. |
| Jemand aktiv | Meldung mit „Jetzt neu starten" und den Wahlen zum Verschieben. Sind die Verschiebungen aufgebraucht oder ist die Frist um, nur noch der letzte Countdown. |
| Server | Abgelehnt mit Begründung — das Backend legt für Server gar keinen Auftrag an, der Agent prüft den Produkttyp ein zweites Mal. |

Die Frist beginnt mit der ersten Meldung. Wahlen, die über sie hinausgingen,
fallen weg; bleibt keine, wird bis zur Frist verschoben.

Der Dienst läuft als LocalSystem in Sitzung 0 und kann selbst nichts zeigen. Er
startet deshalb dieselbe EXE mit `--restart-prompt` im Konto des Benutzers, in
dessen Sitzung, und spricht mit ihr über eine Named Pipe, die nur dieser
Benutzer und das System öffnen dürfen. Die Meldung hat keine Adminrechte und
meldet nur die Wahl; neu startet ausschliesslich der Dienst, über
`shutdown.exe /r /t 30 /d p:2:17` mit einem Kommentar — im Ereignisprotokoll
als Ereignis 1074 nachvollziehbar.

Jeder Schritt geht ans Backend (`/restart-result`): gezeigt, verschoben bis wann
und von wem, eingeleitet, gescheitert. Ob der Neustart geklappt hat, entscheidet
das Backend am nächsten gemeldeten Systemstart. Wird der Auftrag im Backend
abgebrochen, schliesst sich eine offene Meldung beim nächsten Check-in.

Wie die Meldung aussieht, zeigt die Vorschau — ohne Dienst und ohne Folgen,
auch ohne Adminrechte:

```powershell
.\wiupmo-agent.exe --restart-prompt-preview          # mit Verschieben
.\wiupmo-agent.exe --restart-prompt-preview --final  # letzter Countdown
```
