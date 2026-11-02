using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Windows;

/// <summary>Ob Windows gerade installieren kann.</summary>
public enum InstallReadiness
{
    Ready,

    /// <summary>Windows installiert gerade selbst. Spaeter erneut versuchen.</summary>
    Busy,

    /// <summary>
    /// Ein frueheres Update verlangt erst einen Neustart. Neu gestartet wird
    /// nie vom Agent — das bleibt den Richtlinien und dem Benutzer.
    /// </summary>
    RebootRequired,
}

/// <summary>Ergebnis eines Installationsauftrags, je Update in der Reihenfolge des Auftrags.</summary>
public sealed class InstallOutcome
{
    public required IReadOnlyList<InstallUpdateResult> Results { get; init; }

    /// <summary>Gesamtaussage des Installers: Mindestens ein Update will einen Neustart.</summary>
    public required bool RebootRequired { get; init; }

    public int Offered => Results.Count(r => r.Offered);

    public int Installed => Results.Count(r => r.Offered && WindowsUpdateInstaller.IsSuccess(r.ResultCode));
}

/// <summary>Ein angebotenes Update, wie die Probe es zeigt.</summary>
public sealed record OfferedUpdate(string UpdateId, string? KbArticle, string Title);

public sealed record InstallProbe(InstallReadiness Readiness, IReadOnlyList<OfferedUpdate> Offered);

/// <summary>
/// Installiert offene Updates ueber WUApi: suchen, auswaehlen, Lizenz
/// annehmen, herunterladen, installieren.
///
/// Gesucht wird unmittelbar vor dem Installieren noch einmal, statt sich auf
/// den letzten Snapshot zu verlassen. Installiert wird nur, was Windows dann
/// anbietet — am WSUS also nur Freigegebenes. Der Agent umgeht keine Freigabe,
/// er zieht nur vor, was das Geraet ohnehin bekaeme.
///
/// Neu gestartet wird nie. Verlangt ein Update einen Neustart, steht das im
/// Ergebnis und im naechsten Snapshot; ausgefuehrt wird er nach den
/// Richtlinien des Geraets.
/// </summary>
public sealed class WindowsUpdateInstaller(AgentOptions options)
{
    /// <summary>Werte aus <c>OperationResultCode</c>.</summary>
    private const int ResultSucceeded = 2;

    private const int ResultSucceededWithErrors = 3;
    private const int ResultFailed = 4;
    private const int ResultAborted = 5;

    internal static bool IsSuccess(int? resultCode) =>
        resultCode is ResultSucceeded or ResultSucceededWithErrors;

    public Task<InstallReadiness> CheckReadinessAsync(CancellationToken ct) =>
        RunAsync(
            () =>
            {
                object session = CreateSession();
                try
                {
                    return ReadReadiness(CreateInstaller(session));
                }
                finally
                {
                    Com.Release(session);
                }
            },
            TimeSpan.FromSeconds(options.ComTimeoutSeconds),
            "Die Pruefung des Installers",
            ct);

    /// <summary>
    /// Installiert die genannten Updates, soweit Windows sie anbietet.
    ///
    /// Wirft <see cref="WindowsUpdateException"/>, wenn der Auftrag als Ganzes
    /// scheitert — Suche, Download oder Installation brechen ab, das Zeitlimit
    /// laeuft ab. Scheitern einzelne Updates, steht das in deren Ergebnis.
    /// </summary>
    public Task<InstallOutcome> InstallAsync(IReadOnlyList<string> updateIds, CancellationToken ct) =>
        RunAsync(
            () => Install(updateIds),
            TimeSpan.FromMinutes(options.InstallTimeoutMinutes),
            "Die Installation",
            ct);

    /// <summary>
    /// Alles bis auf Herunterladen und Installieren, fuer alle angebotenen
    /// Updates: Suche, Auswahl, Downloader und Installer mit dieser Auswahl.
    /// Zeigt auf einem Geraet, ob der Weg traegt, ohne etwas zu veraendern.
    /// </summary>
    public Task<InstallProbe> ProbeAsync(CancellationToken ct) =>
        RunAsync(Probe, TimeSpan.FromSeconds(options.ComTimeoutSeconds), "Die Probe", ct);

    /// <summary>
    /// Eigener Thread statt Thread-Pool: Eine Installation blockiert ihn fuer
    /// Stunden, und der Aufruf laesst sich nicht abbrechen. Nach Ablauf des
    /// Zeitlimits arbeitet der Thread weiter; als Hintergrund-Thread haelt er
    /// den Prozess beim Beenden nicht auf.
    /// </summary>
    private static async Task<T> RunAsync<T>(Func<T> work, TimeSpan timeout, string what, CancellationToken ct)
    {
        Task<T> task = Task.Factory.StartNew(
            work, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

        try
        {
            return await task.WaitAsync(timeout, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            throw new WindowsUpdateException(
                $"{what} hat das Zeitlimit von {timeout.TotalMinutes:0.#} min ueberschritten. " +
                "Windows arbeitet womoeglich im Hintergrund weiter; der naechste Snapshot zeigt den Stand.");
        }
    }

    // --- Ablauf -----------------------------------------------------------------

    private InstallOutcome Install(IReadOnlyList<string> updateIds)
    {
        object session = CreateSession();

        try
        {
            var wanted = new HashSet<string>(updateIds, StringComparer.OrdinalIgnoreCase);
            object selection = Com.Create("Microsoft.Update.UpdateColl");
            var selected = new List<string>();

            foreach (object update in Search(session))
            {
                if (ReadUpdateId(update) is not { } id || !wanted.Contains(id) || selected.Contains(id))
                {
                    continue;
                }

                // Ohne angenommene Lizenz bricht der Download ab. Angenommen wird
                // nur fuer das, was der Auftrag nennt.
                if (!Com.TryGetBool(update, "EulaAccepted"))
                {
                    Com.Call(update, "AcceptEula");
                }

                Com.Call(selection, "Add", update);
                selected.Add(id);
            }

            var results = new Dictionary<string, InstallUpdateResult>(StringComparer.OrdinalIgnoreCase);
            bool rebootRequired = false;

            if (selected.Count > 0)
            {
                List<(string Id, object Update)> downloaded = Download(session, selection, selected, results);

                if (downloaded.Count > 0)
                {
                    rebootRequired = InstallDownloaded(session, downloaded, results);
                }
            }

            return new InstallOutcome
            {
                Results =
                [
                    .. updateIds.Distinct(StringComparer.OrdinalIgnoreCase).Select(id =>
                        results.TryGetValue(id, out InstallUpdateResult? result)
                            ? result
                            : new InstallUpdateResult { UpdateId = id, Offered = false }),
                ],
                RebootRequired = rebootRequired,
            };
        }
        finally
        {
            Com.Release(session);
        }
    }

    /// <summary>
    /// Laedt die Auswahl herunter. Was dabei scheitert, steht danach mit dem
    /// Ergebnis des Downloads in <paramref name="results"/>; zurueck kommt der Rest.
    /// </summary>
    private static List<(string Id, object Update)> Download(
        object session,
        object selection,
        IReadOnlyList<string> selected,
        Dictionary<string, InstallUpdateResult> results)
    {
        object downloader = Com.Require(Com.Call(session, "CreateUpdateDownloader"), "CreateUpdateDownloader");
        Com.Set(downloader, "Updates", selection);
        object download = Com.Require(Com.Call(downloader, "Download"), "Download");

        var downloaded = new List<(string Id, object Update)>();

        for (int i = 0; i < selected.Count; i++)
        {
            object? itemResult = Com.TryCall(download, "GetUpdateResult", i);
            int code = itemResult is null ? ResultFailed : Com.TryGetInt(itemResult, "ResultCode") ?? ResultFailed;

            if (IsSuccess(code) && Com.TryGet(selection, "Item", i) is { } update)
            {
                downloaded.Add((selected[i], update));
                continue;
            }

            results[selected[i]] = new InstallUpdateResult
            {
                UpdateId = selected[i],
                Offered = true,
                ResultCode = Math.Clamp(code, 0, ResultAborted),
                HResult = itemResult is null ? null : Com.TryGetInt(itemResult, "HResult"),
            };
        }

        return downloaded;
    }

    /// <summary>Installiert, was heruntergeladen ist. Liefert, ob ein Neustart noetig ist.</summary>
    private static bool InstallDownloaded(
        object session,
        IReadOnlyList<(string Id, object Update)> downloaded,
        Dictionary<string, InstallUpdateResult> results)
    {
        object collection = Com.Create("Microsoft.Update.UpdateColl");
        foreach ((_, object update) in downloaded)
        {
            Com.Call(collection, "Add", update);
        }

        object installer = CreateInstaller(session);
        Com.Set(installer, "Updates", collection);
        object install = Com.Require(Com.Call(installer, "Install"), "Install");

        for (int i = 0; i < downloaded.Count; i++)
        {
            object? itemResult = Com.TryCall(install, "GetUpdateResult", i);
            int code = itemResult is null ? ResultFailed : Com.TryGetInt(itemResult, "ResultCode") ?? ResultFailed;

            results[downloaded[i].Id] = new InstallUpdateResult
            {
                UpdateId = downloaded[i].Id,
                Offered = true,
                ResultCode = Math.Clamp(code, 0, ResultAborted),
                HResult = itemResult is null ? null : Com.TryGetInt(itemResult, "HResult"),
                RebootRequired = itemResult is null ? null : Com.TryGetBool(itemResult, "RebootRequired"),
            };
        }

        return Com.TryGetBool(install, "RebootRequired");
    }

    private InstallProbe Probe()
    {
        object session = CreateSession();

        try
        {
            object selection = Com.Create("Microsoft.Update.UpdateColl");
            var offered = new List<OfferedUpdate>();

            foreach (object update in Search(session))
            {
                if (ReadUpdateId(update) is not { } id)
                {
                    continue;
                }

                Com.Call(selection, "Add", update);
                string? kb = Com.ReadStrings(update, "KBArticleIDs", maxItems: 1).FirstOrDefault();
                offered.Add(new OfferedUpdate(id, kb, Com.TryGetString(update, "Title") ?? id));
            }

            // Dieselben Zuweisungen wie beim Installieren, nur ohne Download()
            // und Install(): Scheitert hier etwas, scheitert es dort auch.
            object downloader = Com.Require(Com.Call(session, "CreateUpdateDownloader"), "CreateUpdateDownloader");
            Com.Set(downloader, "Updates", selection);

            object installer = CreateInstaller(session);
            Com.Set(installer, "Updates", selection);

            return new InstallProbe(ReadReadiness(installer), offered);
        }
        finally
        {
            Com.Release(session);
        }
    }

    // --- Bausteine --------------------------------------------------------------

    private static object CreateSession()
    {
        object session = Com.Create("Microsoft.Update.Session");
        Com.Set(session, "ClientApplicationID", "WiUpMo.Agent");
        return session;
    }

    /// <summary>Dieselbe Suche wie bei der Erfassung, damit "angeboten" hier dasselbe heisst.</summary>
    private IEnumerable<object> Search(object session)
    {
        object searcher = Com.Require(Com.Call(session, "CreateUpdateSearcher"), "CreateUpdateSearcher");
        Com.Set(searcher, "Online", options.SearchOnline);

        object result = Com.Require(Com.Call(searcher, "Search", "IsInstalled=0 and IsHidden=0"), "Search");

        int resultCode = Com.TryGetInt(result, "ResultCode") ?? ResultAborted;
        if (!IsSuccess(resultCode))
        {
            throw new WindowsUpdateException(
                $"Die Suche vor der Installation endete mit ResultCode {resultCode}. " +
                "Moegliche Ursachen: die Update-Quelle ist nicht erreichbar oder der Dienst 'wuauserv' laeuft nicht.");
        }

        return Com.Enumerate(Com.TryGet(result, "Updates"), Limits.ArrayItems);
    }

    private static object CreateInstaller(object session)
    {
        object installer = Com.Require(Com.Call(session, "CreateUpdateInstaller"), "CreateUpdateInstaller");

        // Es sitzt niemand davor, der eine Rueckfrage beantworten koennte:
        // keine Aufforderung nach Installationsmedien, keine Oberflaeche.
        // ForceQuiet gibt es erst ab IUpdateInstaller2; fehlt es, geht es ohne.
        Com.TrySet(installer, "AllowSourcePrompts", false);
        Com.TrySet(installer, "ForceQuiet", true);

        return installer;
    }

    private static InstallReadiness ReadReadiness(object installer)
    {
        if (Com.TryGetBool(installer, "IsBusy"))
        {
            return InstallReadiness.Busy;
        }

        return Com.TryGetBool(installer, "RebootRequiredBeforeInstallation")
            ? InstallReadiness.RebootRequired
            : InstallReadiness.Ready;
    }

    private static string? ReadUpdateId(object update)
    {
        object? identity = Com.TryGet(update, "Identity");
        return identity is null ? null : Com.TryGetString(identity, "UpdateID");
    }
}
