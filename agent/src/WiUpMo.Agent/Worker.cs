using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Storage;

namespace WiUpMo.Agent;

public sealed class Worker(
    AgentOptions options,
    AgentCycle cycle,
    CheckinTrigger trigger,
    CheckinSchedule schedule,
    SnapshotQueue queue,
    ILogger<Worker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation(
            "WiUpMo-Agent {Version} gestartet. Backend {Backend}, Intervall {Stunden} h, " +
            "{Wartend} Snapshot(s) in der Warteschlange.",
            AgentVersion.Current, options.BackendUrl, schedule.Interval.TotalHours, queue.Count());

        trigger.Start();

        if (!await DelayAsync(TimeSpan.FromSeconds(options.StartupDelaySeconds), stoppingToken)
                .ConfigureAwait(false))
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await cycle.RunAsync(stoppingToken).ConfigureAwait(false);
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
