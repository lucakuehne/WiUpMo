using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Update;

namespace WiUpMo.Agent;

public sealed class Worker(
    AgentOptions options,
    AgentCycle cycle,
    CheckinTrigger trigger,
    CheckinSchedule schedule,
    SnapshotQueue queue,
    SelfUpdateService selfUpdate,
    ILogger<Worker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation(
            "WiUpMo-Agent {Version} gestartet. Backend {Backend}, Intervall {Minuten} min, " +
            "{Wartend} Snapshot(s) in der Warteschlange.",
            AgentVersion.Current, options.BackendUrl, schedule.Interval.TotalMinutes, queue.Count());

        trigger.Start();

        // Vor der Startverzoegerung: Steht ein Selbst-Update an, soll der Task
        // es mit den richtigen Bedingungen schon beim naechsten Lauf tauschen.
        selfUpdate.EnsureUpdaterTask();
        selfUpdate.RefreshUpdater();

        // Gerade umgestellt: Die Frist des Updaters laeuft, und die Bestaetigung
        // kommt erst nach dem ersten Durchlauf. Die Startverzoegerung wuerde sie
        // nur verkuerzen.
        TimeSpan delay = selfUpdate.AwaitsConfirmation
            ? TimeSpan.Zero
            : TimeSpan.FromSeconds(options.StartupDelaySeconds);

        if (!await DelayAsync(delay, stoppingToken).ConfigureAwait(false))
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                Task run = cycle.RunAsync(stoppingToken);
                await WarnWhileRunningAsync(run, stoppingToken).ConfigureAwait(false);
                await run.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // Der Dienst laeuft weiter. Ein defekter WUApi-Zustand oder ein
                // Fehler im Agent selbst darf nicht dazu fuehren, dass ein
                // Geraet dauerhaft aus der Meldung faellt — beim naechsten
                // Durchlauf kann es wieder klappen.
                logger.LogError(ex, "Durchlauf fehlgeschlagen.");
            }

            try
            {
                // Bei jedem Durchgang neu abgefragt: Der Abstand kann sich mit
                // der letzten Check-in-Antwort geaendert haben.
                if (await trigger.WaitAsync(schedule.Interval, stoppingToken).ConfigureAwait(false))
                {
                    logger.LogInformation("Trigger empfangen, Durchlauf vorgezogen.");
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        logger.LogInformation("WiUpMo-Agent beendet.");
    }

    /// <summary>
    /// Ein Durchlauf, der so lange braucht, haengt: Die Update-Suchen und der
    /// Download haben eigene Zeitlimits, die zusammen deutlich darunter liegen.
    /// </summary>
    private static readonly TimeSpan SlowCycle = TimeSpan.FromMinutes(60);

    /// <summary>
    /// Meldet einen Durchlauf, der nicht fertig wird — einmal je
    /// <see cref="SlowCycle"/>, solange er laeuft.
    ///
    /// Ein haengender Aufruf wirft nichts; er kommt einfach nicht zurueck. Ohne
    /// diese Warnung endete das Protokoll dann mitten im Durchlauf, ohne Fehler
    /// und ohne Hinweis, und das Geraet meldete sich nie wieder.
    /// </summary>
    private async Task WarnWhileRunningAsync(Task run, CancellationToken ct)
    {
        DateTimeOffset started = DateTimeOffset.UtcNow;

        while (await Task.WhenAny(run, Task.Delay(SlowCycle, ct)).ConfigureAwait(false) != run)
        {
            if (ct.IsCancellationRequested)
            {
                return;
            }

            logger.LogError(
                "Der Durchlauf seit {Start:u} ist nach {Minuten:0} Minuten nicht fertig und haengt vermutlich. " +
                "Der letzte Eintrag davor zeigt, wo. Bis er zurueckkommt, meldet dieses Geraet nichts.",
                started, (DateTimeOffset.UtcNow - started).TotalMinutes);
        }
    }

    /// <summary>Liefert <c>false</c>, wenn waehrend des Wartens abgebrochen wurde.</summary>
    private static async Task<bool> DelayAsync(TimeSpan delay, CancellationToken ct)
    {
        if (delay <= TimeSpan.Zero)
        {
            return true;
        }

        try
        {
            await Task.Delay(delay, ct).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }
}
