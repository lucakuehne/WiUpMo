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
///
/// Nach einer halben Stunde darf trotzdem ein neuer Aufruf los: Ein Aufruf
/// kann fuer immer haengen, waehrend der Dienst neue laengst wieder
/// beantwortet. In 0.9.2 bis 0.10.0 sperrte ein einziger solcher Aufruf die
/// Update-Suche bis zum naechsten Neustart des Agents. Hoechstens drei duerfen
/// so liegen bleiben; die Update-Suche selbst laeuft inzwischen ohnehin in
/// einem eigenen Prozess (<see cref="UpdateScanner"/>).
/// </summary>
public sealed class HangGuard(string service)
{
    public static readonly HangGuard WindowsUpdate = new("Windows Update");
    public static readonly HangGuard TaskScheduler = new("Die Aufgabenplanung");
    public static readonly HangGuard Wmi = new("WMI");

    /// <summary>Fuer Abfragen, die sonst nach Sekundenbruchteilen zurueck sind.</summary>
    public static readonly TimeSpan Quick = TimeSpan.FromSeconds(60);

    /// <summary>So lange nach dem Beginn des juengsten haengenden Aufrufs darf ein neuer los.</summary>
    public static readonly TimeSpan RetryAfter = TimeSpan.FromMinutes(30);

    /// <summary>Mehr haengende Aufrufe je Dienst laesst die Wache nicht zu.</summary>
    public const int MaxHanging = 3;

    private readonly Lock _sync = new();
    private readonly List<(Task Task, string Call, DateTimeOffset Since)> _hanging = [];

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
            _hanging.RemoveAll(hanging => hanging.Task.IsCompleted);

            if (_hanging.Count > 0)
            {
                (_, string call, DateTimeOffset since) = _hanging[^1];
                if (_hanging.Count >= MaxHanging || DateTimeOffset.UtcNow - since < RetryAfter)
                {
                    throw new WindowsUpdateException(string.Create(
                        CultureInfo.InvariantCulture,
                        $"{what} uebersprungen: {service} antwortet nicht. {call} haengt seit {since:u}."));
                }
            }
        }

        return Task.Run(work, CancellationToken.None);
    }

    private WindowsUpdateException Hung(Task task, string what, TimeSpan limit)
    {
        lock (_sync)
        {
            _hanging.Add((task, what, DateTimeOffset.UtcNow - limit));
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
