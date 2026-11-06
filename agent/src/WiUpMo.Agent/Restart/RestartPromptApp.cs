using System.IO.Pipes;
using System.Text.Json;
using System.Windows.Forms;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Der Prozess, den der Dienst in der Sitzung des Benutzers startet
/// (<c>--restart-prompt --pipe …</c>): verbindet sich, zeigt die Meldung und
/// schickt die Wahl zurueck. Laeuft ohne Host, ohne Protokoll und ohne
/// Adminrechte.
/// </summary>
public static class RestartPromptApp
{
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(30);

    public static int Run(string? pipeName)
    {
        if (string.IsNullOrWhiteSpace(pipeName))
        {
            return 2;
        }

        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            pipe.Connect(ConnectTimeout);
        }
        catch (TimeoutException)
        {
            return 1;
        }

        using var reader = new StreamReader(pipe, PromptJson.Encoding, leaveOpen: true);
        string? line = reader.ReadLine();
        PromptRequest? request = line is null ? null : JsonSerializer.Deserialize<PromptRequest>(line, PromptJson.Options);
        if (request is null)
        {
            return 1;
        }

        // Endet die Verbindung, ist der Auftrag weggefallen: Die Meldung schliesst sich.
        PromptAnswer? answer = Show(request, form => _ = WatchAsync(reader, form));
        if (answer is null)
        {
            return 0;
        }

        try
        {
            using var writer = new StreamWriter(pipe, PromptJson.Encoding, leaveOpen: true) { AutoFlush = true };
            writer.WriteLine(JsonSerializer.Serialize(answer, PromptJson.Options));
        }
        catch (IOException)
        {
            // Der Dienst hoert nicht mehr zu; er fragt beim naechsten Mal neu.
            return 1;
        }

        return 0;
    }

    /// <summary>
    /// Zeigt die Meldung mit Beispieldaten, ohne Dienst und ohne Folgen, und
    /// gibt die Wahl aus — zum Ansehen vor dem Ausrollen.
    /// <c>--restart-prompt-preview --final</c> zeigt den letzten Countdown.
    /// </summary>
    public static int Preview(bool final)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var request = new Contracts.RestartRequest
        {
            JobId = "vorschau",
            Reason = "Updates abschliessen",
            DeferralMinutes = [60, 240],
            NextMorningHour = 8,
            MaxDeferrals = 3,
            DeadlineHours = 24,
            CountdownMinutes = 10,
            Message = "Fragen beantwortet der Service Desk.",
        };

        PromptAnswer? answer = Show(
            new PromptRequest
            {
                Reason = request.Reason,
                Message = request.Message,
                Deadline = now.AddHours(request.DeadlineHours),
                Final = final,
                CountdownMinutes = request.CountdownMinutes,
                DeferralsLeft = request.MaxDeferrals,
                Options = RestartCoordinator.Choices(request, now, now.AddHours(request.DeadlineHours)),
            },
            _ => { });

        Console.WriteLine(answer is null ? "Keine Wahl." : JsonSerializer.Serialize(answer, PromptJson.Options));
        return 0;
    }

    /// <summary>Windows Forms braucht einen STA-Thread; der Prozess startet ohne.</summary>
    private static PromptAnswer? Show(PromptRequest request, Action<RestartPromptForm> started)
    {
        PromptAnswer? answer = null;

        var thread = new Thread(() =>
        {
            Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            using var form = new RestartPromptForm(request);
            form.HandleCreated += (_, _) => started(form);
            Application.Run(form);
            answer = form.Answer;
        });

        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        return answer;
    }

    private static async Task WatchAsync(StreamReader reader, RestartPromptForm form)
    {
        try
        {
            // Der Dienst schickt nichts weiter; das Lesen endet erst mit der Verbindung.
            await reader.ReadLineAsync().ConfigureAwait(false);
        }
        catch (IOException)
        {
        }
        catch (ObjectDisposedException)
        {
            return;
        }

        try
        {
            if (!form.IsDisposed && form.IsHandleCreated)
            {
                form.BeginInvoke(form.CloseFromOutside);
            }
        }
        catch (InvalidOperationException)
        {
            // Das Fenster ist inzwischen von selbst zu.
        }
    }
}
