using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Windows;

/// <summary>Was der Suchprozess auf die Standardausgabe schreibt, als eine Zeile JSON.</summary>
public sealed class UpdateSearchOutput
{
    public IReadOnlyList<AvailableUpdate>? Available { get; init; }
    public IReadOnlyList<HistoryEntry>? History { get; init; }

    /// <summary>Die installierten Updates; fehlen, wenn nur diese Suche scheiterte.</summary>
    public IReadOnlyList<AvailableUpdate>? Installed { get; init; }

    public string? InstalledError { get; init; }

    /// <summary>Gesetzt, wenn die Suche nach offenen Updates oder die Historie scheiterte.</summary>
    public string? Error { get; init; }
}

/// <summary>
/// Der Suchprozess: <c>wiupmo-agent.exe --wu-search --since &lt;Zeitpunkt&gt; [--offline]</c>.
///
/// Der Dienst startet ihn fuer jede Update-Suche und beendet ihn, wenn er nicht
/// rechtzeitig fertig wird (<see cref="UpdateScanner"/>). Bis 0.10.0 lief die
/// Suche im Dienst selbst; ein COM-Aufruf, der nicht zurueckkam, liess sich dort
/// nicht abbrechen, und der Agent suchte danach bis zu seinem Neustart nicht
/// mehr — obwohl Windows Update neue Anfragen laengst wieder beantwortete.
/// Einen Prozess kann man beenden, und jede Suche beginnt frisch.
///
/// Ohne Host, Konfiguration und Protokoll: Er liest nur Windows Update und
/// schreibt das Ergebnis als JSON.
/// </summary>
public static class UpdateSearchProcess
{
    public const string Flag = "--wu-search";
    public const string SinceOption = "--since";
    public const string OfflineFlag = "--offline";

    public const int ExitOk = 0;
    public const int ExitArguments = 2;
    public const int ExitSearchFailed = 3;

    public static int Run(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

        int index = Array.FindIndex(args, a => a.Equals(SinceOption, StringComparison.OrdinalIgnoreCase));
        if (index < 0
            || index + 1 >= args.Length
            || !DateTimeOffset.TryParse(args[index + 1], CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset since))
        {
            Write(new UpdateSearchOutput { Error = $"{SinceOption} fehlt oder ist kein Zeitpunkt." });
            return ExitArguments;
        }

        bool online = !args.Any(a => a.Equals(OfflineFlag, StringComparison.OrdinalIgnoreCase));

        IReadOnlyList<AvailableUpdate> available;
        IReadOnlyList<HistoryEntry> history;
        try
        {
            available = WindowsUpdateReader.SearchAvailable(online);
            history = WindowsUpdateReader.ReadHistory(since);
        }
        catch (Exception ex) when (IsSearchFailure(ex))
        {
            Write(new UpdateSearchOutput { Error = ex.Message });
            return ExitSearchFailed;
        }

        // Nur fuer den Katalog: Scheitert sie, gehen die offenen Updates trotzdem.
        IReadOnlyList<AvailableUpdate>? installed = null;
        string? installedError = null;
        try
        {
            installed = WindowsUpdateReader.SearchInstalled();
        }
        catch (Exception ex) when (IsSearchFailure(ex))
        {
            installedError = ex.Message;
        }

        Write(new UpdateSearchOutput
        {
            Available = available,
            History = history,
            Installed = installed,
            InstalledError = installedError,
        });
        return ExitOk;
    }

    private static bool IsSearchFailure(Exception ex) =>
        ex is WindowsUpdateException or COMException or InvalidCastException or InvalidOperationException
            or UnauthorizedAccessException;

    private static void Write(UpdateSearchOutput output)
    {
        Console.Out.Write(JsonSerializer.Serialize(output, AgentJson.Options));
        Console.Out.Flush();
    }
}
