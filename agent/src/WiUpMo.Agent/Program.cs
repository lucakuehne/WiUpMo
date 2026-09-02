using System.Net;
using Microsoft.Extensions.Configuration;
using WiUpMo.Agent;
using WiUpMo.Agent.Backend;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Windows;

/// <summary>
/// Phase 1: ein Durchlauf pro Aufruf — sammeln, melden, beenden. Der
/// Dienstbetrieb mit Zeitgeber, Netzwerk-Triggern und SQLite-Warteschlange
/// kommt in Phase 2; bis dahin laesst sich der Agent von Hand oder aus der
/// Aufgabenplanung heraus starten.
/// </summary>
internal static class Program
{
    private const int ExitOk = 0;
    private const int ExitError = 1;
    private const int ExitConfiguration = 2;
    private const int ExitCanceled = 130;

    /// <summary>
    /// Kurzformen fuer die Aufrufzeile. Ohne sie muesste man den vollen
    /// Konfigurationspfad schreiben (<c>--Agent:BackendUrl=...</c>).
    /// </summary>
    private static readonly Dictionary<string, string> SwitchMappings = new()
    {
        ["--backend-url"] = "Agent:BackendUrl",
        ["--enrollment-token"] = "Agent:EnrollmentToken",
        ["--data-directory"] = "Agent:DataDirectory",
        ["--search-online"] = "Agent:SearchOnline",
    };

    public static async Task<int> Main(string[] args)
    {
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cts.Cancel();
        };

        try
        {
            return await RunAsync(args, cts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            Log.Warn("Abgebrochen.");
            return ExitCanceled;
        }
        catch (Exception ex) when (ex is WindowsUpdateException or BackendException or IOException
                                      or HttpRequestException or ArgumentException)
        {
            // Erwartbare Betriebsfehler: unerreichbares Backend, kaputte
            // Update-Datenbank, fehlende Rechte. Die Meldung genuegt, ein
            // Stacktrace hilft hier niemandem.
            Log.Error(ex.Message);
            return ExitError;
        }
        catch (Exception ex)
        {
            // Alles Uebrige ist ein Fehler im Agent selbst — hier ist der
            // Stacktrace die eigentliche Information.
            Log.Error(ex.ToString());
            return ExitError;
        }
    }

    private static async Task<int> RunAsync(string[] args, CancellationToken ct)
    {
        AgentOptions options = LoadOptions(args);

        if (string.IsNullOrWhiteSpace(options.BackendUrl))
        {
            Log.Error(
                "Keine Backend-Adresse konfiguriert. Erwartet wird 'Agent:BackendUrl' in der " +
                "appsettings.json, die Umgebungsvariable WIUPMO_Agent__BackendUrl oder --backend-url.");
            return ExitConfiguration;
        }

        Log.Info($"WiUpMo-Agent {AgentVersion.Current}, Backend {options.BackendUrl}.");

        var store = new DeviceIdentityStore(options.DataDirectory);
        store.EnsureDirectory();
        using var client = new BackendClient(options);

        DateTimeOffset historySince = store.GetLastHistoryTimestamp()
            ?? DateTimeOffset.UtcNow.AddDays(-options.InitialHistoryDays);

        Log.Info($"Erfasse Update-Zustand, Historie seit {historySince:u}.");
        Snapshot snapshot = await new SnapshotCollector(options).CollectAsync(historySince, ct)
            .ConfigureAwait(false);

        Log.Info(
            $"{snapshot.AvailableUpdates.Count} offene Updates, " +
            $"{snapshot.History.Count} Historieneintraege, " +
            $"Quelle {snapshot.UpdateSource.Source}, " +
            $"Neustart ausstehend: {(snapshot.PendingReboot ? "ja" : "nein")}.");

        DeviceIdentity identity = store.TryLoad()
            ?? await EnrollAsync(client, store, options, snapshot.Host, ct).ConfigureAwait(false);

        CheckinResponse response;
        try
        {
            response = await client.CheckinAsync(identity, snapshot, ct).ConfigureAwait(false);
        }
        catch (BackendException ex) when (ex.StatusCode == HttpStatusCode.Unauthorized)
        {
            // Das Secret wurde gesperrt oder das Geraet im Backend entfernt.
            // Einmal neu registrieren und denselben Snapshot erneut senden: die
            // snapshotId bleibt gleich, ein doppelter Empfang ist deshalb
            // unschaedlich.
            Log.Warn("Das Backend hat die Geraeteidentitaet abgelehnt, neue Registrierung.");
            identity = await EnrollAsync(client, store, options, snapshot.Host, ct).ConfigureAwait(false);
            response = await client.CheckinAsync(identity, snapshot, ct).ConfigureAwait(false);
        }

        return Report(response, store, snapshot);
    }

    private static int Report(CheckinResponse response, DeviceIdentityStore store, Snapshot snapshot)
    {
        SnapshotResult? result = response.Results.FirstOrDefault();

        switch (result?.Outcome)
        {
            case "accepted":
            case "duplicate":
                // Erst jetzt den Fortschrittsmarker setzen. Bis zur Bestaetigung
                // gilt die Historie als nicht gemeldet — lieber ein Eintrag
                // doppelt als einer verloren; das Backend erkennt Wiederholungen
                // an der snapshotId.
                store.SetLastHistoryTimestamp(snapshot.CollectedAt);
                Log.Info($"Snapshot uebermittelt ({result.Outcome}).");
                return ExitOk;

            case "rejected":
                Log.Error($"Das Backend hat den Snapshot abgelehnt: {result.Error ?? "ohne Begruendung"}.");
                return ExitError;

            default:
                Log.Error("Das Backend hat kein Ergebnis zum Snapshot geliefert.");
                return ExitError;
        }
    }

    private static async Task<DeviceIdentity> EnrollAsync(
        BackendClient client,
        DeviceIdentityStore store,
        AgentOptions options,
        HostInfo host,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(options.EnrollmentToken))
        {
            throw new ArgumentException(
                "Das Geraet ist noch nicht registriert und es ist kein Enrollment-Token " +
                "konfiguriert ('Agent:EnrollmentToken' bzw. --enrollment-token).");
        }

        Log.Info("Registriere Geraet beim Backend.");

        DeviceIdentity identity = await client.EnrollAsync(
            new EnrollRequest
            {
                EnrollmentToken = options.EnrollmentToken,
                Host = host,
                AgentVersion = AgentVersion.Current,
            },
            ct).ConfigureAwait(false);

        // Sofort ablegen: das Secret wird genau einmal ausgeliefert.
        store.Save(identity);
        Log.Info($"Registriert als Geraet {identity.DeviceId}.");

        return identity;
    }

    private static AgentOptions LoadOptions(string[] args)
    {
        // AppContext.BaseDirectory statt des Arbeitsverzeichnisses: als Dienst
        // gestartet ist das Arbeitsverzeichnis system32, dort liegt keine
        // appsettings.json.
        IConfiguration configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true, reloadOnChange: false)
            .AddEnvironmentVariables("WIUPMO_")
            .AddCommandLine(args, SwitchMappings)
            .Build();

        var options = new AgentOptions();
        configuration.GetSection("Agent").Bind(options);
        return options;
    }
}
