using System.Net.NetworkInformation;
using Microsoft.Extensions.Logging;

namespace WiUpMo.Agent;

/// <summary>
/// Loest einen ausserplanmaessigen Durchlauf aus, sobald sich am Netzwerk etwas
/// aendert — der Fall, auf den es ankommt, ist der VPN-Aufbau: gepufferte
/// Snapshots sollen dann zeitnah nachgereicht werden statt bis zum naechsten
/// regulaeren Intervall zu warten.
///
/// Die Entprellung ist nicht optional. Ein einzelner VPN-Aufbau erzeugt eine
/// Reihe von Ereignissen — Adapter oben, Adresse zugewiesen, Route gesetzt —
/// und ohne Mindestabstand liefe der Agent mehrfach hintereinander los, jedes
/// Mal mit einer vollstaendigen WUApi-Suche.
/// </summary>
public sealed class CheckinTrigger(AgentOptions options, ILogger<CheckinTrigger> logger) : IDisposable
{
    private readonly SemaphoreSlim _signal = new(0, 1);
    private readonly Lock _gate = new();
    private readonly TimeSpan _debounce = TimeSpan.FromMinutes(options.NetworkDebounceMinutes);

    private DateTimeOffset _lastSignal = DateTimeOffset.MinValue;
    private bool _pending;
    private bool _started;

    public void Start()
    {
        if (_started)
        {
            return;
        }

        NetworkChange.NetworkAvailabilityChanged += OnAvailabilityChanged;
        NetworkChange.NetworkAddressChanged += OnAddressChanged;
        _started = true;
    }

    private void OnAvailabilityChanged(object? sender, NetworkAvailabilityEventArgs e)
    {
        // Nur das Verfuegbarwerden ist interessant. Beim Verlust der Verbindung
        // haette ein Durchlauf ohnehin niemanden zu melden.
        if (e.IsAvailable)
        {
            Signal("Netzwerk verfuegbar");
        }
    }

    private void OnAddressChanged(object? sender, EventArgs e) => Signal("Netzwerkadresse geaendert");

    private void Signal(string reason)
    {
        lock (_gate)
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            if (now - _lastSignal < _debounce)
            {
                return;
            }

            _lastSignal = now;

            // Mehr als ein ausstehendes Signal ergibt keinen Sinn: der naechste
            // Durchlauf erfasst den aktuellen Stand ohnehin vollstaendig.
            if (_pending)
            {
                return;
            }

            _pending = true;
            _signal.Release();
        }

        logger.LogInformation("Ausserplanmaessiger Durchlauf angefordert: {Grund}.", reason);
    }

    /// <summary>
    /// Wartet auf einen Trigger, laengstens <paramref name="timeout"/>.
    /// Liefert <c>true</c>, wenn ein Trigger kam, <c>false</c> beim Ablauf der
    /// Wartezeit.
    /// </summary>
    public async Task<bool> WaitAsync(TimeSpan timeout, CancellationToken ct)
    {
        bool triggered = await _signal.WaitAsync(timeout, ct).ConfigureAwait(false);

        if (triggered)
        {
            lock (_gate)
            {
                _pending = false;
            }
        }

        return triggered;
    }

    public void Dispose()
    {
        if (_started)
        {
            NetworkChange.NetworkAvailabilityChanged -= OnAvailabilityChanged;
            NetworkChange.NetworkAddressChanged -= OnAddressChanged;
            _started = false;
        }

        _signal.Dispose();
    }
}
