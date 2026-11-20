using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Windows;

/// <summary>Ergebnis einer Update-Suche.</summary>
public sealed record UpdateScanResult(
    IReadOnlyList<AvailableUpdate> Available,
    IReadOnlyList<HistoryEntry> History,
    IReadOnlyList<AvailableUpdate>? Installed);

/// <summary>
/// Sucht nach Updates — in einem eigenen Prozess (<see cref="UpdateSearchProcess"/>),
/// den sie beendet, wenn er nicht rechtzeitig fertig wird.
///
/// Haengt Windows Update fuer diesen einen Aufruf, bleibt nichts zurueck: kein
/// Thread, der ewig wartet, und keine Sperre fuer die naechste Suche. Die
/// beginnt in einem neuen Prozess, als waere nichts gewesen.
/// </summary>
public sealed class UpdateScanner(AgentOptions options, ILogger<UpdateScanner> logger)
{
    /// <summary>
    /// Zur Suche nach offenen Updates (<see cref="AgentOptions.ComTimeoutSeconds"/>)
    /// kommen Historie und die oertliche Suche nach installierten; die brauchen
    /// Sekunden, selten mehr als eine Minute.
    /// </summary>
    private static readonly TimeSpan ExtraTime = TimeSpan.FromMinutes(2);

    public async Task<UpdateScanResult> ScanAsync(DateTimeOffset since, CancellationToken ct)
    {
        if (options.SimulateWindowsUpdateFailure)
        {
            throw new WindowsUpdateException("Die Update-Suche ist simuliert gescheitert (Ende-zu-Ende-Test).");
        }

        if (options.SimulateWindowsUpdate)
        {
            return new UpdateScanResult([], [], []);
        }

        string exe = Environment.ProcessPath
            ?? throw new WindowsUpdateException("Der Pfad der eigenen EXE ist unbekannt; die Suche laesst sich nicht starten.");

        TimeSpan limit = TimeSpan.FromSeconds(Math.Max(30, options.ComTimeoutSeconds)) + ExtraTime;

        var start = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = Path.GetDirectoryName(exe),
        };
        start.ArgumentList.Add(UpdateSearchProcess.Flag);
        start.ArgumentList.Add(UpdateSearchProcess.SinceOption);
        start.ArgumentList.Add(since.ToString("O", CultureInfo.InvariantCulture));
        if (!options.SearchOnline)
        {
            start.ArgumentList.Add(UpdateSearchProcess.OfflineFlag);
        }

        Process process;
        try
        {
            process = Process.Start(start)
                ?? throw new WindowsUpdateException("Der Suchprozess liess sich nicht starten.");
        }
        catch (Win32Exception ex)
        {
            throw new WindowsUpdateException($"Der Suchprozess liess sich nicht starten: {ex.Message}", ex);
        }

        using (process)
        {
            // Beide Stroeme lesen, waehrend der Prozess laeuft: Ein voller Puffer
            // hielte ihn sonst an, und die Liste der Updates ist nicht klein.
            Task<string> output = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
            Task<string> error = process.StandardError.ReadToEndAsync(CancellationToken.None);

            using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                timeout.CancelAfter(limit);
                try
                {
                    await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    Kill(process);
                    ct.ThrowIfCancellationRequested();
                    throw new WindowsUpdateException(string.Create(
                        CultureInfo.InvariantCulture,
                        $"Die Update-Suche hat das Zeitlimit von {limit.TotalSeconds:0} s ueberschritten und wurde abgebrochen. Windows Update antwortet nicht."));
                }
            }

            string json = await output.ConfigureAwait(false);
            string stderr = await error.ConfigureAwait(false);

            UpdateSearchOutput? result = Parse(json);
            if (result?.Error is { } message)
            {
                throw new WindowsUpdateException(message);
            }

            if (process.ExitCode != UpdateSearchProcess.ExitOk || result?.Available is null)
            {
                throw new WindowsUpdateException(string.Create(
                    CultureInfo.InvariantCulture,
                    $"Der Suchprozess endete mit {process.ExitCode}. {Limits.Truncate(stderr.Trim(), 300)}").Trim());
            }

            if (result.InstalledError is { } installedError)
            {
                logger.LogDebug("Installierte Updates nicht lesbar: {Fehler}", installedError);
            }

            return new UpdateScanResult(result.Available, result.History ?? [], result.Installed);
        }
    }

    private static UpdateSearchOutput? Parse(string json)
    {
        try
        {
            return string.IsNullOrWhiteSpace(json) ? null : JsonSerializer.Deserialize<UpdateSearchOutput>(json, AgentJson.Options);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit(5000);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException)
        {
            // Inzwischen von selbst beendet, oder Windows laesst es nicht zu.
            logger.LogDebug("Der Suchprozess liess sich nicht beenden: {Fehler}", ex.Message);
        }
    }
}
