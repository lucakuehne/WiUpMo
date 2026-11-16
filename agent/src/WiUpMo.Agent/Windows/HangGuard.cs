using System.Globalization;

namespace WiUpMo.Agent.Windows;

/// <summary>
/// Zeitlimit fuer COM-Aufrufe an einen Windows-Dienst — und hoechstens ein
/// haengender Aufruf je Dienst.
///
/// Ein COM-Aufruf laesst sich nicht abbrechen. Laeuft er ins Zeitlimit, wartet
/// sein Thread weiter, bis der Dienst antwortet; haengt der Dienst, fuer immer.
/// Ohne Sperre kaeme bei jedem Durchlauf ein solcher Thread dazu. Solange der
/// haengende Aufruf nicht zurueck ist, scheitert deshalb jeder weitere an
/// denselben Dienst sofort, mit einer Meldung, seit wann. Kommt er zurueck,
/// geht es ohne Neustart des Agents weiter.
///
/// Ausserhalb der Update-Suche fehlte das Zeitlimit frueher ganz: Hing der
/// Windows-Update-Dienst, blieb der Durchlauf beim Lesen des Neustart-Status
/// stehen — ohne eine Zeile im Protokoll und ohne je wieder zu melden.
/// </summary>
public sealed class HangGuard(string service)
{
    public static readonly HangGuard WindowsUpdate = new("Windows Update");
    public static readonly HangGuard TaskScheduler = new("Die Aufgabenplanung");

    /// <summary>Fuer Abfragen, die sonst nach Sekundenbruchteilen zurueck sind.</summary>
    public static readonly TimeSpan Quick = TimeSpan.FromSeconds(60);

    private readonly Lock _sync = new();
    private Task? _hanging;
    private string? _hangingCall;
    private DateTimeOffset _hangingSince;

    public async Task<T> RunAsync<T>(Func<T> work, TimeSpan limit, string what, CancellationToken ct)
    {
        Task<T> task = Start(work, what);

        try
        {
            return await task.WaitAsync(limit, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            throw Hung(task, what, limit);
        }
    }

    public T Run<T>(Func<T> work, TimeSpan limit, string what)
    {
        Task<T> task = Start(work, what);

        bool done;
        try
        {
            done = task.Wait(limit);
        }
        catch (AggregateException)
        {
            // Fertig, aber gescheitert: Die Ausnahme kommt unten ausgepackt.
            done = true;
        }

        if (!done)
        {
            throw Hung(task, what, limit);
        }

        return task.GetAwaiter().GetResult();
    }

    private Task<T> Start<T>(Func<T> work, string what)
    {
        lock (_sync)
        {
            if (_hanging is { IsCompleted: false })
            {
                throw new WindowsUpdateException(string.Create(
                    CultureInfo.InvariantCulture,
                    $"{what} uebersprungen: {service} antwortet nicht. {_hangingCall} haengt seit {_hangingSince:u}."));
            }

            _hanging = null;
        }

        return Task.Run(work, CancellationToken.None);
    }

    private WindowsUpdateException Hung(Task task, string what, TimeSpan limit)
    {
        lock (_sync)
        {
            _hanging = task;
            _hangingCall = what;
            _hangingSince = DateTimeOffset.UtcNow - limit;
        }

        // Scheitert der Aufruf spaeter doch noch, fragt niemand mehr nach dem
        // Ergebnis; die Ausnahme gilt damit als beobachtet.
        _ = task.ContinueWith(
            t => _ = t.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            System.Threading.Tasks.TaskScheduler.Default);

        return new WindowsUpdateException(string.Create(
            CultureInfo.InvariantCulture,
            $"{what} hat das Zeitlimit von {limit.TotalSeconds:0} s ueberschritten. {service} antwortet nicht."));
    }
}
