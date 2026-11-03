using System.Diagnostics;
using System.Security;
using System.Text;

namespace WiUpMo.Agent.Install;

/// <summary>
/// Der geplante Task, der alle 5 Minuten den Updater ausfuehrt.
///
/// Angelegt wird er aus einer XML-Definition statt mit
/// <c>schtasks /Create /SC MINUTE</c>. Der kurze Weg uebernimmt die
/// Voreinstellungen der Aufgabenplanung, und die sind fuer ein Notebook
/// falsch: Der Task startet nicht im Akkubetrieb, und ein Lauf, der in den
/// Ruhezustand faellt, wird nicht nachgeholt. Ein bereitgelegtes Update blieb
/// so auf einem Notebook stehen, bis der Dienst es nach zwei Stunden aufgab —
/// mit der Meldung, der Task laufe vermutlich nicht. Am Netzteil tauschte
/// derselbe Updater innerhalb von Minuten.
///
/// Der Dienst prueft beim Start, ob der Task so eingerichtet ist, und ersetzt
/// ihn sonst. Damit werden auch Installationen korrigiert, die ihn noch mit
/// dem kurzen Weg angelegt haben.
/// </summary>
public static class UpdaterTask
{
    /// <summary>Was eine Definition von uns ausmacht; fehlt eines, wird ersetzt.</summary>
    private static readonly string[] RequiredSettings =
    [
        "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "<StartWhenAvailable>true</StartWhenAvailable>",
    ];

    /// <summary>
    /// Legt den Task an oder ersetzt ihn. Liefert <c>null</c> bei Erfolg,
    /// sonst die Ausgabe von <c>schtasks</c>.
    /// </summary>
    public static string? Register(string updaterExe, string workDirectory)
    {
        Directory.CreateDirectory(workDirectory);
        string file = Path.Combine(workDirectory, "updater-task.xml");

        try
        {
            // UTF-16 mit BOM, passend zur Kopfzeile: Mit einer anderen Kodierung
            // lehnt schtasks die Datei als fehlerhaft ab.
            File.WriteAllText(file, Definition(updaterExe), Encoding.Unicode);

            (int exitCode, string output) = Run(
                "/Create", "/TN", ServiceInstaller.UpdaterTaskName, "/XML", file, "/F");

            return exitCode == 0 ? null : output.Trim();
        }
        finally
        {
            try
            {
                File.Delete(file);
            }
            catch (IOException)
            {
                // Bleibt liegen, wird beim naechsten Mal ueberschrieben.
            }
        }
    }

    /// <summary>
    /// <c>true</c>, wenn der Task existiert und so eingerichtet ist, wie
    /// <see cref="Register"/> ihn anlegt; <c>false</c>, wenn er fehlt oder alt
    /// ist; <c>null</c>, wenn sich das nicht feststellen liess.
    /// </summary>
    public static bool? IsCurrent()
    {
        try
        {
            (int exitCode, string output) = Run("/Query", "/TN", ServiceInstaller.UpdaterTaskName, "/XML");
            if (exitCode != 0)
            {
                return false;
            }

            return RequiredSettings.All(setting => output.Contains(setting, StringComparison.OrdinalIgnoreCase));
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>
    /// Alle 5 Minuten ab einem Zeitpunkt in der Vergangenheit, ohne Ende. Als
    /// SYSTEM mit hoechsten Rechten, weil der Updater den Dienst anhalten und in
    /// ProgramFiles tauschen muss. Ein Lauf darf hoechstens 30 Minuten dauern;
    /// ein zweiter startet nicht, solange der erste laeuft.
    /// </summary>
    private static string Definition(string updaterExe) =>
        $"""
        <?xml version="1.0" encoding="UTF-16"?>
        <Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
          <RegistrationInfo>
            <Description>Tauscht eine bereitgelegte Fassung des WiUpMo-Agents ein. Beendet sich sofort, wenn nichts ansteht.</Description>
          </RegistrationInfo>
          <Triggers>
            <TimeTrigger>
              <Repetition>
                <Interval>PT5M</Interval>
                <StopAtDurationEnd>false</StopAtDurationEnd>
              </Repetition>
              <StartBoundary>2020-01-01T00:00:00</StartBoundary>
              <Enabled>true</Enabled>
            </TimeTrigger>
          </Triggers>
          <Principals>
            <Principal id="System">
              <UserId>S-1-5-18</UserId>
              <RunLevel>HighestAvailable</RunLevel>
            </Principal>
          </Principals>
          <Settings>
            <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
            <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
            <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
            <StartWhenAvailable>true</StartWhenAvailable>
            <AllowStartOnDemand>true</AllowStartOnDemand>
            <Enabled>true</Enabled>
            <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
            <Priority>7</Priority>
          </Settings>
          <Actions Context="System">
            <Exec>
              <Command>{SecurityElement.Escape(updaterExe)}</Command>
              <Arguments>--updater</Arguments>
            </Exec>
          </Actions>
        </Task>
        """;

    private static (int ExitCode, string Output) Run(params string[] arguments)
    {
        var startInfo = new ProcessStartInfo("schtasks.exe")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (string argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("schtasks.exe liess sich nicht starten.");

        // Beide Stroeme lesen, bevor gewartet wird: Ein voller Puffer haelt den
        // Prozess sonst an.
        Task<string> error = process.StandardError.ReadToEndAsync();
        string output = process.StandardOutput.ReadToEnd();

        if (!process.WaitForExit(30_000))
        {
            process.Kill();
            return (-1, "schtasks.exe antwortete nicht innerhalb von 30 Sekunden.");
        }

        return (process.ExitCode, output + error.Result);
    }
}
