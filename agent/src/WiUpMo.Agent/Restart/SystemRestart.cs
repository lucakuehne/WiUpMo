using System.Diagnostics;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Leitet den Neustart ein — ueber <c>shutdown.exe</c>, wie es auch eine
/// Administratorin von Hand taete.
///
/// Mit Grundcode <c>p:2:17</c> (Betriebssystem, Hotfix, geplant) und einem
/// Kommentar: Beides steht danach im Ereignisprotokoll (Ereignis 1074), und wer
/// sich ueber einen Neustart wundert, findet dort, woher er kam. Dreissig
/// Sekunden Vorlauf, damit die Rueckmeldung ans Backend noch hinausgeht.
/// </summary>
public static class SystemRestart
{
    private const int DelaySeconds = 30;

    public static void Initiate(string comment)
    {
        var start = new ProcessStartInfo("shutdown.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (string argument in new[]
                 {
                     "/r", "/t", DelaySeconds.ToString(System.Globalization.CultureInfo.InvariantCulture),
                     "/d", "p:2:17", "/c", Limits.Truncate(comment, 500),
                 })
        {
            start.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("shutdown.exe liess sich nicht starten.");

        if (!process.WaitForExit(15_000))
        {
            throw new InvalidOperationException("shutdown.exe hat nicht geantwortet.");
        }

        if (process.ExitCode != 0)
        {
            string detail = process.StandardError.ReadToEnd().Trim();
            throw new InvalidOperationException(
                $"shutdown.exe endete mit {process.ExitCode}{(detail.Length > 0 ? $": {detail}" : string.Empty)}.");
        }
    }
}
