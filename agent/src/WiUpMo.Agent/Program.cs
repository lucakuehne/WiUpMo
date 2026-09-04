using System.Diagnostics;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;
using Microsoft.Extensions.Logging;
using Serilog;
using Serilog.Events;
using WiUpMo.Agent;
using WiUpMo.Agent.Backend;
using WiUpMo.Agent.Install;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Update;
using WiUpMo.Agent.Windows;

/// <summary>
/// Einstiegspunkt fuer alle Betriebsarten:
///
/// <list type="table">
///   <item><term>(ohne)</term><description>Dienstbetrieb bzw. Dauerlauf im Vordergrund</description></item>
///   <item><term>--once</term><description>Ein einzelner Durchlauf, dann beenden — zum Pruefen</description></item>
///   <item><term>--install</term><description>Als Windows-Dienst einrichten und starten</description></item>
///   <item><term>--uninstall</term><description>Dienst entfernen, Daten behalten</description></item>
/// </list>
/// </summary>
internal static class Program
{
    private const int ExitOk = 0;
    private const int ExitError = 1;
    private const int ExitConfiguration = 2;

    /// <summary>
    /// Schalter ohne Wert. Sie muessen vor der Konfigurationsbindung heraus,
    /// weil <c>AddCommandLine</c> jedes <c>--x</c> als Schluessel mit folgendem
    /// Wert liest und bei einem alleinstehenden Schalter abbricht.
    /// </summary>
    private static readonly string[] Flags =
        ["--install", "--uninstall", "--once", "--service", "--updater"];

    private static readonly Dictionary<string, string> SwitchMappings = new()
    {
        ["--backend-url"] = "Agent:BackendUrl",
        ["--enrollment-token"] = "Agent:EnrollmentToken",
        ["--data-directory"] = "Agent:DataDirectory",
        ["--search-online"] = "Agent:SearchOnline",
        ["--interval-hours"] = "Agent:CheckIntervalHours",
    };

    public static async Task<int> Main(string[] args)
    {
        AgentOptions options = LoadOptions(args);

        // Einrichtung laeuft ohne Host und ohne Serilog: sie schreibt auf die
        // Konsole, weil sie von Hand oder aus einem Startskript aufgerufen wird.
        if (HasFlag(args, "--install"))
        {
            return ServiceInstaller.Install(options);
        }

        if (HasFlag(args, "--uninstall"))
        {
            return ServiceInstaller.Uninstall(options);
        }

        // Der Updater-Lauf kommt vom geplanten Task und braucht weder Host noch
        // Serilog: Er schreibt auf die Konsole, die der Task mitprotokolliert,
        // und beendet sich in aller Regel sofort wieder.
        if (HasFlag(args, "--updater"))
        {
            return Updater.Run(new AgentPaths(options.DataDirectory));
        }

        // Der Schalter zaehlt zuerst: er steht im binPath der Dienstregistrierung
        // und ist damit eine ausdrueckliche Ansage. Die Erkennung ueber den
        // Elternprozess bleibt als zweiter Weg, greift aber nicht in jeder
        // Startkonstellation — und wo sie danebenliegt, laeuft der Host als
        // gewoehnliche Konsolenanwendung, meldet dem Dienstmanager nie den
        // Start und laesst ihn nach 30 s mit Fehler 1053 abbrechen.
        bool asService = HasFlag(args, "--service") || WindowsServiceHelpers.IsWindowsService();
        Serilog.Log.Logger = CreateLogger(options, asService);

        try
        {
            if (string.IsNullOrWhiteSpace(options.BackendUrl))
            {
                Serilog.Log.Fatal(
                    "Keine Backend-Adresse konfiguriert. Erwartet wird 'Agent:BackendUrl' in der " +
                    "appsettings.json, die Umgebungsvariable WIUPMO_Agent__BackendUrl oder --backend-url.");
                return ExitConfiguration;
            }

            using IHost host = BuildHost(options, asService);
            PrepareStorage(host, options);

            if (HasFlag(args, "--once"))
            {
                using var cts = new CancellationTokenSource();
                Console.CancelKeyPress += (_, e) =>
                {
                    e.Cancel = true;
                    cts.Cancel();
                };

                await host.Services.GetRequiredService<AgentCycle>()
                    .RunAsync(cts.Token).ConfigureAwait(false);
                return ExitOk;
            }

            await host.RunAsync().ConfigureAwait(false);
            return ExitOk;
        }
        catch (OperationCanceledException)
        {
            return ExitOk;
        }
        catch (InvalidOperationException ex)
        {
            // Betriebs- statt Programmfehler: die Meldung ist die Information,
            // ein Stacktrace hilft hier niemandem.
            Serilog.Log.Fatal("{Fehler}", ex.Message);
            return ExitConfiguration;
        }
        catch (Exception ex)
        {
            Serilog.Log.Fatal(ex, "Der Agent wurde wegen eines Fehlers beendet.");
            return ExitError;
        }
        finally
        {
            await Serilog.Log.CloseAndFlushAsync().ConfigureAwait(false);
        }
    }

    private static IHost BuildHost(AgentOptions options, bool asService)
    {
        // Der regulaere Builder, nicht der leere: er bringt eine
        // Standard-Lebensdauer mit, die AddWindowsService dann ersetzt. Ohne
        // eine solche laeuft der Host im Dienstkontext ohne Gegenueber.
        //
        // ContentRootPath ausdruecklich auf das Programmverzeichnis — als Dienst
        // gestartet waere es sonst system32.
        HostApplicationBuilder builder = Host.CreateApplicationBuilder(
            new HostApplicationBuilderSettings
            {
                ContentRootPath = AppContext.BaseDirectory,
                Args = [],
            });

        builder.Logging.ClearProviders();
        builder.Logging.AddSerilog(Serilog.Log.Logger, dispose: false);

        if (asService)
        {
            // Bewusst nicht ueber AddWindowsService(): die Methode prueft
            // intern selbst noch einmal auf Dienstkontext — ueber den
            // Elternprozess — und tut schlicht nichts, wenn diese Heuristik
            // danebenliegt. Der Host laeuft dann mit der Konsolen-Lebensdauer
            // weiter, meldet dem Dienstmanager nie den Start und wird nach
            // dessen Zeitlimit mit Fehler 1053 abgeraeumt.
            //
            // '--service' steht im binPath der Registrierung und ist damit eine
            // Ansage statt einer Vermutung. Die Lebensdauer wird deshalb direkt
            // eingetragen; sie ueberschreibt die vom Builder voreingestellte.
            builder.Services.Configure<WindowsServiceLifetimeOptions>(
                o => o.ServiceName = ServiceInstaller.ServiceName);
            builder.Services.AddSingleton<IHostLifetime, WindowsServiceLifetime>();
        }

        builder.Services.AddSingleton(options);
        builder.Services.AddSingleton<HostInspector>();
        builder.Services.AddSingleton<UpdateSourceInspector>();
        builder.Services.AddSingleton<WindowsUpdateReader>();
        builder.Services.AddSingleton<SnapshotCollector>();
        builder.Services.AddSingleton(_ => new DeviceIdentityStore(options.DataDirectory));
        builder.Services.AddSingleton<SnapshotQueue>();
        builder.Services.AddSingleton<BackendClient>();
        builder.Services.AddSingleton<CheckinTrigger>();
        builder.Services.AddSingleton(_ => new AgentPaths(options.DataDirectory));
        builder.Services.AddSingleton<SelfUpdateService>();
        builder.Services.AddSingleton<AgentCycle>();
        builder.Services.AddHostedService<Worker>();

        return builder.Build();
    }

    private static void PrepareStorage(IHost host, AgentOptions options)
    {
        var identityStore = host.Services.GetRequiredService<DeviceIdentityStore>();
        var queue = host.Services.GetRequiredService<SnapshotQueue>();

        try
        {
            identityStore.EnsureDirectory();
            queue.Open();
        }
        catch (Exception ex) when (ex is SqliteException or UnauthorizedAccessException or IOException)
        {
            // Der haeufigste Fall ist kein Defekt, sondern eine Rechtefrage:
            // nach --install gehoert das Datenverzeichnis SYSTEM und den
            // Administratoren. Die rohe SQLite-Meldung "unable to open database
            // file" fuehrt an dieser Erklaerung vorbei.
            throw new InvalidOperationException(
                $"Das Datenverzeichnis {options.DataDirectory} ist nicht zugaenglich: {ex.Message} " +
                "Nach --install ist es auf SYSTEM und Administratoren beschraenkt — ein Aufruf von Hand " +
                "braucht deshalb erhoehte Rechte, oder ein eigenes --data-directory.",
                ex);
        }

        // Beim Wechsel von Phase 1 auf Phase 2 wandert der Fortschrittsmarker
        // aus der state.json in die Warteschlangendatenbank.
        queue.ImportLegacyMarker(identityStore.GetLastHistoryTimestamp());
    }

    private static Serilog.ILogger CreateLogger(AgentOptions options, bool asService)
    {
        const string template =
            "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {Message:lj}{NewLine}{Exception}";

        LoggerConfiguration configuration = new LoggerConfiguration()
            .MinimumLevel.Information()
            .MinimumLevel.Override("Microsoft.Hosting.Lifetime", LogEventLevel.Warning)
            .Enrich.WithProperty("AgentVersion", AgentVersion.Current)
            .WriteTo.Console(outputTemplate: template);

        // Die Datei ist der eigentliche Ablageort; die Konsole sieht im
        // Dienstbetrieb ohnehin niemand.
        try
        {
            string logDirectory = Path.Combine(options.DataDirectory, "logs");
            Directory.CreateDirectory(logDirectory);

            configuration = configuration.WriteTo.File(
                Path.Combine(logDirectory, "agent-.log"),
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: options.LogRetentionDays,
                outputTemplate: template,
                shared: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"Protokolldatei nicht verfuegbar: {ex.Message}");
        }

        // Ins Ereignisprotokoll gehen nur Warnungen und Fehler. Es ist der Ort,
        // an dem ein Administrator nachsieht, der nichts vom Agent weiss — mit
        // jedem Durchlauf vollgeschrieben waere es dafuer wertlos.
        if (asService && EventSourceUsable())
        {
            configuration = configuration.WriteTo.EventLog(
                source: ServiceInstaller.EventSourceName,
                logName: "Application",
                manageEventSource: false,
                restrictedToMinimumLevel: LogEventLevel.Warning);
        }

        return configuration.CreateLogger();
    }

    private static bool EventSourceUsable()
    {
        try
        {
            return EventLog.SourceExists(ServiceInstaller.EventSourceName);
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or InvalidOperationException)
        {
            return false;
        }
    }

    private static bool HasFlag(string[] args, string flag) =>
        args.Contains(flag, StringComparer.OrdinalIgnoreCase);

    private static AgentOptions LoadOptions(string[] args)
    {
        // AppContext.BaseDirectory statt des Arbeitsverzeichnisses: als Dienst
        // gestartet ist das Arbeitsverzeichnis system32, dort liegt keine
        // appsettings.json.
        IConfiguration configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: true, reloadOnChange: false)
            .AddEnvironmentVariables("WIUPMO_")
            .AddCommandLine([.. args.Where(a => !Flags.Contains(a, StringComparer.OrdinalIgnoreCase))], SwitchMappings)
            .Build();

        var options = new AgentOptions();
        configuration.GetSection("Agent").Bind(options);
        return options;
    }
}
