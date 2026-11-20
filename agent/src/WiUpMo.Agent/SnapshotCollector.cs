using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Windows;

namespace WiUpMo.Agent;

public sealed class SnapshotCollector(
    UpdateScanner scanner,
    UpdateSearchSchedule searches,
    HostInspector host,
    UpdateSourceInspector updateSource,
    HardwareReporter hardware,
    SnapshotQueue queue,
    ILogger<SnapshotCollector> logger)
{
    private const string InstalledFingerprintKey = "installed_updates_fingerprint";
    private const string InstalledSentAtKey = "installed_updates_sent_at";

    /// <summary>
    /// Spaetestens so oft gehen die installierten Updates auch unveraendert
    /// mit — falls das Backend sie nicht mehr hat, etwa nach dem Einspielen
    /// einer Sicherung.
    /// </summary>
    private static readonly TimeSpan InstalledRefresh = TimeSpan.FromDays(1);

    /// <summary>
    /// Erfasst den vollstaendigen Zustand des Geraets.
    ///
    /// <c>collectedAt</c> wird zu Beginn gesetzt, nicht am Ende: der Zeitstempel
    /// ist zugleich der Fortschrittsmarker fuer die Historie. Wird er auf den
    /// Startzeitpunkt gesetzt, faellt ein Historieneintrag, der waehrend der
    /// laufenden Erfassung entsteht, in das naechste Fenster — bei einem
    /// Endzeitpunkt fiele er dagegen durch beide Fenster und ginge verloren.
    ///
    /// Ist Windows Update nicht lesbar, entsteht ein Snapshot ohne Update-Daten
    /// statt gar keiner. Frueher fiel der Durchlauf dann aus, und ein Geraet mit
    /// haengendem Update-Dienst verschwand stumm aus der Ueberwachung — kein
    /// Check-in, keine Stoerung, nur ein immer aelterer Zeitstempel.
    ///
    /// Ab 0.10.1 wird nur gesucht, wenn es <see cref="UpdateSearchSchedule"/>
    /// sagt; dazwischen geht der Snapshot ebenfalls ohne Update-Daten hinaus,
    /// dann aber ohne Warnung — das ist kein Fehler, sondern der Takt.
    /// </summary>
    public async Task<Snapshot> CollectAsync(
        DateTimeOffset historySince,
        AgentDiagnostics diagnostics,
        CancellationToken ct)
    {
        DateTimeOffset collectedAt = DateTimeOffset.UtcNow;

        HostInfo hostInfo = host.Read();
        UpdateSourceInfo source = updateSource.Read();
        bool pendingReboot = host.IsRebootPending();

        // Unabhaengig von Windows Update: Haengt das, kommt die Hardware trotzdem.
        HardwareInfo? hardwareInfo = hardware.ReadIfDue(collectedAt);

        IReadOnlyList<AvailableUpdate>? available = null;
        IReadOnlyList<HistoryEntry> history = [];
        IReadOnlyList<AvailableUpdate>? installed = null;

        if (searches.Due(collectedAt) is { } reason)
        {
            logger.LogInformation("Suche nach Updates ({Anlass}).", reason);
            try
            {
                UpdateScanResult scan = await scanner.ScanAsync(historySince, ct).ConfigureAwait(false);
                available = scan.Available;
                history = scan.History;
                installed = SelectInstalled(scan.Installed, history.Count > 0, collectedAt);
                searches.Succeeded(collectedAt);
            }
            catch (WindowsUpdateException ex)
            {
                // Ganz oder gar nicht: Offene Updates ohne die Historie dazu
                // ergaeben im Backend falsche Uebergaenge.
                available = null;
                history = [];
                installed = null;
                searches.Failed(collectedAt);

                // Kein Programmfehler, sondern ein Zustand des Geraets: als
                // Warnung im Klartext, ohne Stapelspur.
                logger.LogWarning("Update-Zustand nicht lesbar, Check-in ohne Update-Daten. {Meldung}", ex.Message);
            }
        }
        else
        {
            logger.LogInformation(
                "Update-Suche nicht faellig, die naechste ab {Ab:HH:mm} Uhr.",
                searches.NextAt?.ToLocalTime());
        }

        return new Snapshot
        {
            SnapshotId = Guid.NewGuid(),
            CollectedAt = collectedAt,
            AgentVersion = AgentVersion.Current,
            Host = hostInfo,
            UpdateSource = source,
            PendingReboot = pendingReboot,
            AvailableUpdates = available,
            History = history,
            InstalledUpdates = installed,
            Diagnostics = diagnostics,
            Hardware = hardwareInfo,
        };
    }

    /// <summary>
    /// Die installierten Updates, wenn sie sich seit dem letzten Mitsenden
    /// geaendert haben — sonst null, und der Snapshot bleibt so klein wie
    /// bisher.
    ///
    /// Mitgeschickt wird nur, wenn die Historie Neues meldet oder das letzte
    /// Mitsenden einen Tag her ist: Ohne Installation oder Deinstallation
    /// aendert sich die Menge nicht. Liess sich die Liste nicht lesen, fehlt sie
    /// in diesem Snapshot. Sie dient nur dem Katalog und ist kein Grund, den
    /// Durchlauf aufzugeben.
    /// </summary>
    private IReadOnlyList<AvailableUpdate>? SelectInstalled(
        IReadOnlyList<AvailableUpdate>? installed,
        bool historyChanged,
        DateTimeOffset now)
    {
        bool sentRecently = DateTimeOffset.TryParse(
                                queue.GetMeta(InstalledSentAtKey),
                                CultureInfo.InvariantCulture,
                                DateTimeStyles.RoundtripKind,
                                out DateTimeOffset sentAt)
                            && now - sentAt < InstalledRefresh;
        if (!historyChanged && sentRecently)
        {
            return null;
        }

        if (installed is not { Count: > 0 })
        {
            return null;
        }

        string fingerprint = Fingerprint(installed);
        if (sentRecently && queue.GetMeta(InstalledFingerprintKey) == fingerprint)
        {
            return null;
        }

        queue.SetMeta(InstalledFingerprintKey, fingerprint);
        queue.SetMeta(InstalledSentAtKey, now.ToString("O", CultureInfo.InvariantCulture));
        return installed;
    }

    /// <summary>Welche Updates in welcher Revision — die Reihenfolge der Suche zaehlt nicht.</summary>
    private static string Fingerprint(IReadOnlyList<AvailableUpdate> installed) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join(
            '\n',
            installed.Select(update => $"{update.UpdateId}:{update.RevisionNumber}").Order(StringComparer.Ordinal)))));
}
