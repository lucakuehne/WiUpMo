using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Windows;

namespace WiUpMo.Agent;

public sealed class SnapshotCollector(
    WindowsUpdateReader updates,
    HostInspector host,
    UpdateSourceInspector updateSource,
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

        IReadOnlyList<AvailableUpdate> available =
            await updates.GetAvailableUpdatesAsync(ct).ConfigureAwait(false);
        IReadOnlyList<HistoryEntry> history =
            await updates.GetHistoryAsync(historySince, ct).ConfigureAwait(false);
        IReadOnlyList<AvailableUpdate>? installed =
            await ReadInstalledIfChangedAsync(history.Count > 0, collectedAt, ct).ConfigureAwait(false);

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
        };
    }

    /// <summary>
    /// Die installierten Updates, wenn sie sich seit dem letzten Mitsenden
    /// geaendert haben — sonst null, und der Snapshot bleibt so klein wie
    /// bisher.
    ///
    /// Gesucht wird nur, wenn die Historie Neues meldet oder das letzte
    /// Mitsenden einen Tag her ist: Ohne Installation oder Deinstallation
    /// aendert sich die Menge nicht. Scheitert die Suche, fehlt die Liste in
    /// diesem Snapshot. Sie dient nur dem Katalog und ist kein Grund, den
    /// Durchlauf aufzugeben.
    /// </summary>
    private async Task<IReadOnlyList<AvailableUpdate>?> ReadInstalledIfChangedAsync(
        bool historyChanged,
        DateTimeOffset now,
        CancellationToken ct)
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

        IReadOnlyList<AvailableUpdate> installed;
        try
        {
            installed = await updates.GetInstalledUpdatesAsync(ct).ConfigureAwait(false);
        }
        catch (WindowsUpdateException ex)
        {
            logger.LogWarning("Die installierten Updates liessen sich nicht lesen. {Meldung}", ex.Message);
            return null;
        }

        if (installed.Count == 0)
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
