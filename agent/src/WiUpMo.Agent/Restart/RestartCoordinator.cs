using System.ComponentModel;
using System.Globalization;
using System.Net;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Backend;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Update;
using WiUpMo.Agent.Windows;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Fuehrt Neustart-Auftraege aus: fragt den angemeldeten Benutzer, laesst ihn
/// in Grenzen verschieben und startet neu.
///
/// Der Ablauf, je Durchgang alle 15 Sekunden:
/// <list type="number">
///   <item>Niemand angemeldet: sofort neu starten.</item>
///   <item>Angemeldet, aber die Sitzung getrennt: Dort laesst sich nichts zeigen.
///   Die Frist laeuft trotzdem; an ihrem Ende wird neu gestartet.</item>
///   <item>Jemand aktiv: Meldung mit „Jetzt neu starten" und den Wahlen zum
///   Verschieben. Sind die Verschiebungen aufgebraucht oder ist die Frist um,
///   nur noch der letzte Countdown.</item>
/// </list>
/// Jeder Schritt geht ans Backend. Ob der Neustart geklappt hat, entscheidet
/// das Backend aber am naechsten gemeldeten Systemstart, nicht an dieser Meldung.
/// </summary>
public sealed class RestartCoordinator(
    AgentOptions options,
    AgentPaths paths,
    BackendClient backend,
    DeviceIdentityStore identities,
    HostInspector host,
    ILogger<RestartCoordinator> logger) : BackgroundService
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(15);

    /// <summary>Wurde die Meldung ohne Antwort geschlossen, kommt sie nach dieser Zeit wieder.</summary>
    private static readonly TimeSpan Reprompt = TimeSpan.FromMinutes(10);

    /// <summary>Liess sich die Meldung nicht zeigen, der naechste Versuch.</summary>
    private static readonly TimeSpan LaunchRetry = TimeSpan.FromMinutes(5);

    /// <summary>Eine getrennte Sitzung wird so oft darauf geprueft, ob jemand zurueck ist.</summary>
    private static readonly TimeSpan AbsentRecheck = TimeSpan.FromMinutes(1);

    /// <summary>Eingeleitet, aber nach dieser Zeit noch nicht neu gestartet: gescheitert.</summary>
    private static readonly TimeSpan RestartGrace = TimeSpan.FromMinutes(15);

    private static readonly TimeSpan ReportTimeout = TimeSpan.FromSeconds(15);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private RestartState? _state;
    private bool _loaded;
    private PromptSession? _prompt;

    /// <summary>
    /// Uebernimmt den Auftrag aus der juengsten Check-in-Antwort. Fehlt er, ist er
    /// im Backend weggefallen — abgebrochen, verfallen oder durch einen Neustart
    /// des Benutzers erledigt —, und eine offene Meldung schliesst sich.
    /// </summary>
    public async Task ApplyAsync(RestartRequest? request, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            RestartState? state = Load();

            if (request is null || string.IsNullOrEmpty(request.JobId))
            {
                if (state is { RestartingAt: null, Closed: false })
                {
                    logger.LogInformation(
                        "Neustart-Auftrag {Auftrag} ist im Backend nicht mehr offen und entfaellt.", state.Request.JobId);
                    Drop();
                }

                return;
            }

            if (state is not null && (state.Request.JobId == request.JobId || state.RestartingAt is not null))
            {
                return;
            }

            ClosePrompt();
            _state = new RestartState { Request = request, ReceivedAt = DateTimeOffset.UtcNow };
            Save();
            logger.LogInformation("Neustart-Auftrag {Auftrag} angenommen.", request.JobId);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Schickt, was das Backend noch nicht bestaetigt hat. Laeuft bei jedem Durchlauf.</summary>
    public async Task ReportPendingAsync(DeviceIdentity identity, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await FlushAsync(identity, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await _gate.WaitAsync(stoppingToken).ConfigureAwait(false);
                try
                {
                    await TickAsync(stoppingToken).ConfigureAwait(false);
                }
                finally
                {
                    _gate.Release();
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or Win32Exception
                                          or InvalidOperationException)
            {
                logger.LogWarning("Neustart-Auftrag: {Fehler}", ex.Message);
            }

            try
            {
                await Task.Delay(Tick, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        ClosePrompt();
    }

    private async Task TickAsync(CancellationToken ct)
    {
        RestartState? state = Load();
        if (state is null)
        {
            return;
        }

        DateTimeOffset now = DateTimeOffset.UtcNow;

        if (state.Closed)
        {
            await TryFlushAsync(ct).ConfigureAwait(false);
            return;
        }

        if (state.RestartingAt is { } since)
        {
            if (LastBoot() > since)
            {
                // Neu gestartet. Erledigt ist der Auftrag damit; das Backend sieht
                // es am gemeldeten Systemstart.
                logger.LogInformation("Neustart-Auftrag {Auftrag} ist mit dem Neustart erledigt.", state.Request.JobId);
                Drop();
            }
            else if (now - since > RestartGrace)
            {
                await FailAsync(state, "Der Neustart wurde eingeleitet, ist aber nicht erfolgt.", ct).ConfigureAwait(false);
            }

            return;
        }

        // Simuliert wird nie neu gestartet; der Test laeuft auf einem
        // Windows-Server-Runner und braucht den Weg fuer Arbeitsplaetze.
        if (!options.SimulateRestart && host.IsServer())
        {
            await FailAsync(state, "Server werden nicht auf Anforderung neu gestartet.", ct).ConfigureAwait(false);
            return;
        }

        if (_prompt is not null)
        {
            await FollowPromptAsync(state, now, ct).ConfigureAwait(false);
            return;
        }

        if (state.NextPromptAt is { } next && now < next)
        {
            return;
        }

        // Im Test gibt es niemanden, dem sich etwas zeigen liesse.
        IReadOnlyList<UserSession> sessions = options.SimulateRestart ? [] : UserSessions.List();
        if (sessions.Count == 0)
        {
            await RestartAsync(state, user: null, "niemand angemeldet", ct).ConfigureAwait(false);
            return;
        }

        bool first = state.DeadlineAt is null;
        DateTimeOffset deadline = state.DeadlineAt ??= now + TimeSpan.FromHours(Math.Clamp(state.Request.DeadlineHours, 1, 168));

        UserSession? active = sessions.FirstOrDefault(s => s.Active);
        if (active is null)
        {
            if (first)
            {
                Report(state, "notified", now, user: sessions[0].User, note: "Sitzung getrennt, Meldung folgt bei Rueckkehr");
            }

            if (now >= deadline)
            {
                await RestartAsync(state, sessions[0].User, "Frist abgelaufen, Sitzung getrennt", ct).ConfigureAwait(false);
                return;
            }

            state.NextPromptAt = now + AbsentRecheck;
            Save();
            await TryFlushAsync(ct).ConfigureAwait(false);
            return;
        }

        bool final = state.Deferrals >= state.Request.MaxDeferrals || now >= deadline;
        List<PromptOption> choices = final ? [] : Choices(state.Request, now, deadline);
        final |= choices.Count == 0;

        var prompt = new PromptRequest
        {
            Reason = state.Request.Reason,
            Template = PromptTemplate.For(state.Request),
            Deadline = deadline,
            Final = final,
            CountdownMinutes = Countdown(state.Request),
            DeferralsLeft = Math.Max(0, state.Request.MaxDeferrals - state.Deferrals),
            Options = choices,
        };

        try
        {
            _prompt = PromptSession.Start(active, prompt);
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException
                                      or UnauthorizedAccessException)
        {
            logger.LogWarning("Die Neustart-Meldung liess sich nicht zeigen: {Fehler}", ex.Message);
            if (now >= deadline)
            {
                await RestartAsync(state, active.User, "Frist abgelaufen, Meldung nicht anzeigbar", ct)
                    .ConfigureAwait(false);
                return;
            }

            state.NextPromptAt = now + LaunchRetry;
            Save();
            return;
        }

        logger.LogInformation(
            "Neustart-Meldung fuer {Benutzer} gezeigt ({Art}).", active.User, final ? "letzter Countdown" : "verschiebbar");
        Report(state, "notified", now, user: active.User, note: final ? "letzter Countdown" : null);
        state.NextPromptAt = null;
        Save();
        await TryFlushAsync(ct).ConfigureAwait(false);
    }

    /// <summary>Wartet auf die Wahl des Benutzers — und startet notfalls ohne sie neu.</summary>
    private async Task FollowPromptAsync(RestartState state, DateTimeOffset now, CancellationToken ct)
    {
        PromptSession prompt = _prompt!;

        if (!prompt.Answer.IsCompleted)
        {
            // Die Meldung zaehlt selbst herunter. Bleibt danach die Antwort aus,
            // wird trotzdem neu gestartet: Die Frist gilt.
            if (state.DeadlineAt is { } deadline
                && now > deadline + TimeSpan.FromMinutes(Countdown(state.Request) + 5))
            {
                ClosePrompt();
                await RestartAsync(state, prompt.User, "Frist abgelaufen, keine Antwort", ct).ConfigureAwait(false);
            }

            return;
        }

        PromptAnswer? answer = await prompt.Answer.ConfigureAwait(false);
        ClosePrompt();

        switch (answer?.Choice)
        {
            case "now":
                await RestartAsync(state, prompt.User, "vom Benutzer bestaetigt", ct).ConfigureAwait(false);
                return;

            case "timeout":
                await RestartAsync(state, prompt.User, "Countdown abgelaufen", ct).ConfigureAwait(false);
                return;

            case "defer" when answer.Until is { } until && state.Deferrals < state.Request.MaxDeferrals:
                DateTimeOffset latest = state.DeadlineAt ?? until;
                DateTimeOffset next = until > latest ? latest : until;
                if (next < now + TimeSpan.FromMinutes(1))
                {
                    next = now + TimeSpan.FromMinutes(1);
                }

                state.Deferrals++;
                state.NextPromptAt = next;
                Report(state, "deferred", now, user: prompt.User, until: next);
                Save();
                logger.LogInformation(
                    "Neustart von {Benutzer} verschoben bis {Bis:u} ({Anzahl}. Mal).", prompt.User, next, state.Deferrals);
                await TryFlushAsync(ct).ConfigureAwait(false);
                return;

            default:
                // Ohne Antwort geschlossen — abgemeldet oder beendet. Das zaehlt
                // nicht als Verschiebung; die Meldung kommt wieder.
                state.NextPromptAt = now + Reprompt;
                Save();
                return;
        }
    }

    private async Task RestartAsync(RestartState state, string? user, string note, CancellationToken ct)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        state.RestartingAt = now;
        state.NextPromptAt = null;
        Report(state, "restarting", now, user: user, note: note);
        Save();

        // Erst melden, dann neu starten: Danach ist das Netz weg.
        using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            timeout.CancelAfter(ReportTimeout);
            await TryFlushAsync(timeout.Token).ConfigureAwait(false);
        }

        if (options.SimulateRestart)
        {
            await File.WriteAllTextAsync(
                    paths.RestartSimulatedPath,
                    $"{state.Request.JobId} {now:O} {note}{Environment.NewLine}",
                    ct)
                .ConfigureAwait(false);
            logger.LogInformation("Neustart simuliert ({Grund}).", note);
            Drop();
            return;
        }

        try
        {
            SystemRestart.Initiate(Comment(state.Request));
            logger.LogWarning("Neustart eingeleitet ({Grund}).", note);
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
        {
            state.RestartingAt = null;
            await FailAsync(state, $"Der Neustart liess sich nicht einleiten: {ex.Message}", ct).ConfigureAwait(false);
        }
    }

    private async Task FailAsync(RestartState state, string error, CancellationToken ct)
    {
        logger.LogWarning("Neustart-Auftrag {Auftrag}: {Fehler}", state.Request.JobId, error);
        Report(state, "failed", DateTimeOffset.UtcNow, error: error);
        state.Closed = true;
        Save();
        await TryFlushAsync(ct).ConfigureAwait(false);
    }

    private static void Report(
        RestartState state,
        string result,
        DateTimeOffset at,
        string? user = null,
        DateTimeOffset? until = null,
        string? note = null,
        string? error = null)
    {
        state.Unreported.Add(new RestartResultRequest
        {
            JobId = state.Request.JobId,
            State = result,
            At = at,
            DeadlineAt = state.DeadlineAt,
            DeferredUntil = until,
            Deferrals = state.Deferrals,
            User = user is null ? null : Limits.Truncate(user, 256),
            Note = note,
            Error = error is null ? null : Limits.Truncate(error, 2048),
        });
    }

    private async Task TryFlushAsync(CancellationToken ct)
    {
        if (identities.TryLoad() is { } identity)
        {
            await FlushAsync(identity, ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Schickt die ausstehenden Rueckmeldungen der Reihe nach. Kennt das Backend
    /// den Auftrag nicht mehr als offen, entfaellt er auch hier.
    /// </summary>
    private async Task FlushAsync(DeviceIdentity identity, CancellationToken ct)
    {
        RestartState? state = Load();
        if (state is null)
        {
            return;
        }

        while (state.Unreported.Count > 0)
        {
            try
            {
                await backend.ReportRestartResultAsync(identity, state.Unreported[0], ct).ConfigureAwait(false);
            }
            catch (BackendException ex) when (ex.StatusCode == HttpStatusCode.NotFound)
            {
                if (state.RestartingAt is null)
                {
                    logger.LogInformation(
                        "Neustart-Auftrag {Auftrag} ist im Backend nicht mehr offen und entfaellt.", state.Request.JobId);
                    Drop();
                    return;
                }
            }
            catch (Exception ex) when (ex is BackendException or HttpRequestException or TaskCanceledException
                                          && !ct.IsCancellationRequested)
            {
                logger.LogInformation("Neustart-Rueckmeldung wartet auf das Backend: {Fehler}", ex.Message);
                return;
            }
            catch (OperationCanceledException)
            {
                return;
            }

            state.Unreported.RemoveAt(0);
            Save();
        }

        if (state.Closed)
        {
            Drop();
        }
    }

    /// <summary>
    /// Die Wahlen zum Verschieben, soweit sie vor der Frist enden. Passt keine
    /// mehr, bleibt „bis zur Frist" — solange die mehr als fuenf Minuten weg ist.
    /// </summary>
    internal static List<PromptOption> Choices(RestartRequest request, DateTimeOffset now, DateTimeOffset deadline)
    {
        var choices = new List<PromptOption>();

        foreach (int minutes in request.DeferralMinutes.Where(m => m > 0).Distinct().Order())
        {
            DateTimeOffset until = now.AddMinutes(minutes);
            if (until <= deadline)
            {
                choices.Add(new PromptOption { Label = MinutesLabel(minutes), Until = until });
            }
        }

        if (request.NextMorningHour is int hour and >= 0 and <= 23)
        {
            DateTime local = now.ToLocalTime().DateTime;
            DateTime morning = local.Date.AddHours(hour);
            if (morning <= local)
            {
                morning = morning.AddDays(1);
            }

            DateTimeOffset until = new DateTimeOffset(morning, TimeZoneInfo.Local.GetUtcOffset(morning)).ToUniversalTime();
            if (until <= deadline && choices.TrueForAll(c => Math.Abs((c.Until - until).TotalMinutes) >= 1))
            {
                string day = morning.Date == local.Date ? "heute" : "morgen";
                choices.Add(new PromptOption
                {
                    Label = string.Create(CultureInfo.InvariantCulture, $"bis {day}, {hour:00}:00 Uhr"),
                    Until = until,
                });
            }
        }

        if (choices.Count == 0 && deadline - now > TimeSpan.FromMinutes(5))
        {
            DateTime local = deadline.ToLocalTime().DateTime;
            choices.Add(new PromptOption
            {
                Label = string.Create(CultureInfo.InvariantCulture, $"bis {local:HH:mm} Uhr"),
                Until = deadline,
            });
        }

        return choices;
    }

    internal static string MinutesLabel(int minutes) => minutes switch
    {
        < 60 => string.Create(CultureInfo.InvariantCulture, $"{minutes} Minuten"),
        60 => "1 Stunde",
        _ when minutes % 60 == 0 => string.Create(CultureInfo.InvariantCulture, $"{minutes / 60} Stunden"),
        _ => string.Create(CultureInfo.InvariantCulture, $"{minutes / 60} Std. {minutes % 60} Min."),
    };

    private static int Countdown(RestartRequest request) => Math.Clamp(request.CountdownMinutes, 1, 60);

    private static string Comment(RestartRequest request) =>
        string.IsNullOrWhiteSpace(request.Reason)
            ? "WiUpMo: Neustart angefordert."
            : $"WiUpMo: Neustart angefordert. {request.Reason}";

    /// <summary>Der letzte Systemstart, aus der Laufzeit seit dem Start.</summary>
    private static DateTimeOffset LastBoot() =>
        DateTimeOffset.UtcNow - TimeSpan.FromMilliseconds(Environment.TickCount64);

    private RestartState? Load()
    {
        if (!_loaded)
        {
            _state = RestartState.TryLoad(paths.RestartStatePath);
            _loaded = true;
        }

        return _state;
    }

    private void Save() => _state?.Save(paths.RestartStatePath);

    private void Drop()
    {
        ClosePrompt();
        RestartState.TryDelete(paths.RestartStatePath);
        _state = null;
    }

    private void ClosePrompt()
    {
        _prompt?.Dispose();
        _prompt = null;
    }

    public override void Dispose()
    {
        ClosePrompt();
        _gate.Dispose();
        base.Dispose();
    }
}
