using System.Globalization;
using System.Text.RegularExpressions;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Windows;

/// <summary>
/// Liest die offenen Updates und die Installationshistorie ueber WUApi.
/// </summary>
public sealed partial class WindowsUpdateReader(AgentOptions options)
{
    /// <summary>Werte aus <c>OperationResultCode</c>.</summary>
    private const int ResultSucceeded = 2;

    private const int ResultSucceededWithErrors = 3;
    private const int ResultAborted = 5;

    /// <summary>Werte aus <c>UpdateOperation</c>.</summary>
    private const int OperationInstallation = 1;

    private const int OperationUninstallation = 2;

    /// <summary>Werte aus <c>InstallationRebootBehavior</c>.</summary>
    private const int RebootNever = 0;

    private const int RebootAlways = 1;

    /// <summary>
    /// Historieneintraege tragen keine KB-Nummer als eigenes Feld — anders als
    /// die Verfuegbar-Liste. Sie steht nur im Titel, typischerweise als
    /// "(KB5034123)".
    /// </summary>
    [GeneratedRegex(@"KB(\d{6,10})", RegexOptions.IgnoreCase)]
    private static partial Regex KbInTitle();

    public Task<IReadOnlyList<AvailableUpdate>> GetAvailableUpdatesAsync(CancellationToken ct) =>
        RunWithTimeoutAsync(SearchAvailable, "Die Update-Suche", ct);

    public Task<IReadOnlyList<HistoryEntry>> GetHistoryAsync(
        DateTimeOffset since,
        CancellationToken ct) =>
        RunWithTimeoutAsync(() => ReadHistory(since), "Die Abfrage der Historie", ct);

    /// <summary>
    /// Kapselt einen COM-Aufruf mit Zeitlimit.
    ///
    /// Der Aufruf selbst laesst sich nicht abbrechen — nach Ablauf des
    /// Zeitlimits arbeitet der Thread-Pool-Thread also weiter. Er ist ein
    /// Hintergrund-Thread und haelt den Prozess beim Beenden nicht auf. Genau
    /// dafuer ist die Kapselung da: eine beschaedigte Update-Datenbank kann
    /// eine Suche praktisch unbegrenzt blockieren, und der Agent darf daran
    /// nicht haengenbleiben.
    /// </summary>
    private async Task<T> RunWithTimeoutAsync<T>(Func<T> work, string what, CancellationToken ct)
    {
        Task<T> task = Task.Run(work, CancellationToken.None);

        try
        {
            return await task
                .WaitAsync(TimeSpan.FromSeconds(options.ComTimeoutSeconds), ct)
                .ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            throw new WindowsUpdateException(
                $"{what} hat das Zeitlimit von {options.ComTimeoutSeconds} s ueberschritten. " +
                "Das deutet auf eine beschaedigte Windows-Update-Datenbank hin.");
        }
    }

    // --- Verfuegbare Updates -------------------------------------------------

    private IReadOnlyList<AvailableUpdate> SearchAvailable()
    {
        object session = Com.Create("Microsoft.Update.Session");

        try
        {
            Com.Set(session, "ClientApplicationID", "WiUpMo.Agent");

            object searcher = Com.Require(
                Com.Call(session, "CreateUpdateSearcher"), "CreateUpdateSearcher");

            // Online=true befragt die konfigurierte Quelle (WSUS, Microsoft
            // Update); false liest nur den lokalen Zwischenspeicher.
            Com.Set(searcher, "Online", options.SearchOnline);

            object result = Com.Require(
                Com.Call(searcher, "Search", "IsInstalled=0 and IsHidden=0"), "Search");

            int resultCode = Com.TryGetInt(result, "ResultCode") ?? ResultAborted;
            if (resultCode is not (ResultSucceeded or ResultSucceededWithErrors))
            {
                throw new WindowsUpdateException(
                    $"Die Update-Suche endete mit ResultCode {resultCode}. " +
                    "Moegliche Ursachen: die Update-Quelle ist nicht erreichbar oder der Dienst 'wuauserv' laeuft nicht.");
            }

            return
            [
                .. Com.Enumerate(Com.TryGet(result, "Updates"), Limits.ArrayItems)
                    .Select(MapAvailable)
                    .Where(update => update is not null)
                    .Select(update => update!)
            ];
        }
        finally
        {
            Com.Release(session);
        }
    }

    private static AvailableUpdate? MapAvailable(object update)
    {
        object? identity = Com.TryGet(update, "Identity");
        string? updateId = identity is null ? null : Com.TryGetString(identity, "UpdateID");
        if (string.IsNullOrEmpty(updateId))
        {
            // Ohne UpdateID gibt es keinen Schluessel fuer den Katalog. So ein
            // Eintrag ist fuer die Auswertung wertlos.
            return null;
        }

        string[] categories = Com.ReadStrings(update, "Categories", "Name", maxItems: 32);
        string[] bulletins = Com.ReadStrings(update, "SecurityBulletinIDs", maxItems: 8);
        string[] kbArticles = Com.ReadStrings(update, "KBArticleIDs", maxItems: 8);
        string? severity = Com.TryGetString(update, "MsrcSeverity");

        return new AvailableUpdate
        {
            UpdateId = Limits.Truncate(updateId, Limits.UpdateId),
            RevisionNumber = identity is null ? null : Com.TryGetInt(identity, "RevisionNumber"),
            KbArticle = Limits.TruncateOrNull(NormalizeKb(kbArticles.FirstOrDefault()), Limits.KbArticle),
            Title = Limits.Truncate(Com.TryGetString(update, "Title") ?? updateId, Limits.Title),
            Severity = Limits.TruncateOrNull(severity, Limits.Severity),
            Categories = categories.Length > 0 ? categories : null,
            IsSecurity = IsSecurity(categories, bulletins, severity),
            MsrcNumber = Limits.TruncateOrNull(bulletins.FirstOrDefault(), Limits.MsrcNumber),
            SizeBytes = FormatSize(Com.TryGetDecimal(update, "MaxDownloadSize")),
            SupportUrl = Limits.TruncateOrNull(Com.TryGetString(update, "SupportUrl"), Limits.SupportUrl),
            RebootRequired = ReadRebootBehavior(update),
        };
    }

    /// <summary>
    /// Drei unabhaengige Hinweise, von denen jeder fuer sich genuegt: die
    /// Kategorie, eine MSRC-Nummer oder eine gesetzte Severity. Kein einzelner
    /// davon ist bei allen Quellen zuverlaessig gesetzt — WSUS liefert oft
    /// weniger Metadaten als Microsoft Update.
    /// </summary>
    private static bool IsSecurity(string[] categories, string[] bulletins, string? severity) =>
        bulletins.Length > 0
        || !string.IsNullOrEmpty(severity)
        || categories.Any(c => c.Contains("Security", StringComparison.OrdinalIgnoreCase)
                            || c.Contains("Sicherheit", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// <c>CanRequestReboot</c> (2) bleibt bewusst <c>null</c>: "kann einen
    /// Neustart anfordern" ist weder ein Ja noch ein Nein, und ein falsches
    /// "Ja" wuerde die Auswertung "Reboot ausstehend" verwaessern.
    /// </summary>
    private static bool? ReadRebootBehavior(object update)
    {
        object? behavior = Com.TryGet(update, "InstallationBehavior");
        if (behavior is null)
        {
            return null;
        }

        return Com.TryGetInt(behavior, "RebootBehavior") switch
        {
            RebootNever => false,
            RebootAlways => true,
            _ => null,
        };
    }

    /// <summary>
    /// Als Zeichenkette, weil die Spalte im Backend <c>bigint</c> ist und
    /// <c>MaxDownloadSize</c> als <c>decimal</c> herauskommt.
    /// </summary>
    private static string? FormatSize(decimal? size) =>
        size is null or <= 0 ? null : ((long)size.Value).ToString(CultureInfo.InvariantCulture);

    private static string? NormalizeKb(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        // WUApi liefert die Nummer ohne Praefix, andere Quellen mit. Im Backend
        // steht sie ohne — sonst waere dieselbe KB zweimal im Katalog.
        string trimmed = value.Trim();
        return trimmed.StartsWith("KB", StringComparison.OrdinalIgnoreCase)
            ? trimmed[2..]
            : trimmed;
    }

    // --- Historie ------------------------------------------------------------

    private IReadOnlyList<HistoryEntry> ReadHistory(DateTimeOffset since)
    {
        object session = Com.Create("Microsoft.Update.Session");

        try
        {
            object searcher = Com.Require(
                Com.Call(session, "CreateUpdateSearcher"), "CreateUpdateSearcher");

            int total = Com.ToInt(Com.Call(searcher, "GetTotalHistoryCount")) ?? 0;
            if (total <= 0)
            {
                return [];
            }

            // QueryHistory wirft, wenn ueber das Ende hinaus gelesen wird.
            int take = Math.Min(total, Limits.ArrayItems);
            object entries = Com.Require(
                Com.Call(searcher, "QueryHistory", 0, take), "QueryHistory");

            return
            [
                .. Com.Enumerate(entries, take)
                    .Select(MapHistory)
                    .Where(entry => entry is not null && entry.OccurredAt > since)
                    .Select(entry => entry!)
                    .OrderBy(entry => entry.OccurredAt)
            ];
        }
        finally
        {
            Com.Release(session);
        }
    }

    private static HistoryEntry? MapHistory(object entry)
    {
        DateTime? date = Com.TryGetDateTime(entry, "Date");
        if (date is null)
        {
            return null;
        }

        // WUApi gibt den Zeitpunkt in UTC zurueck, marshallt ihn aber ohne
        // Kind. Ohne dieses SpecifyKind wuerde er als Ortszeit gelesen und die
        // Zeitreihe waere um den Zeitzonenversatz verschoben.
        var occurredAt = new DateTimeOffset(DateTime.SpecifyKind(date.Value, DateTimeKind.Utc));

        object? identity = Com.TryGet(entry, "UpdateIdentity");
        string? updateId = identity is null ? null : Com.TryGetString(identity, "UpdateID");

        string title = Com.TryGetString(entry, "Title") ?? "(ohne Titel)";

        // Ausserhalb von 0..5 lehnt das Backend den Snapshot ab. Ein
        // unbekannter Wert wird als "abgebrochen" gefuehrt statt als Erfolg —
        // im Zweifel lieber ein zu pessimistischer Zustand.
        int resultCode = Com.TryGetInt(entry, "ResultCode") ?? ResultAborted;
        if (resultCode is < 0 or > ResultAborted)
        {
            resultCode = ResultAborted;
        }

        return new HistoryEntry
        {
            UpdateId = Limits.TruncateOrNull(updateId, Limits.UpdateId),
            RevisionNumber = identity is null ? null : Com.TryGetInt(identity, "RevisionNumber"),
            KbArticle = ExtractKb(title),
            Title = Limits.Truncate(title, Limits.Title),
            Operation = Com.TryGetInt(entry, "Operation") switch
            {
                OperationInstallation => HistoryOperation.Installation,
                OperationUninstallation => HistoryOperation.Uninstallation,
                _ => HistoryOperation.Other,
            },
            ResultCode = resultCode,
            HResult = Com.TryGetInt(entry, "HResult") ?? 0,
            OccurredAt = occurredAt,
            SupportUrl = Limits.TruncateOrNull(Com.TryGetString(entry, "SupportUrl"), Limits.SupportUrl),
        };
    }

    private static string? ExtractKb(string title)
    {
        Match match = KbInTitle().Match(title);
        return match.Success ? match.Groups[1].Value : null;
    }
}
