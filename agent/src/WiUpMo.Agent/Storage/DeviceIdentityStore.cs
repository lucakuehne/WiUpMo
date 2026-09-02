using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace WiUpMo.Agent.Storage;

public sealed record DeviceIdentity(string DeviceId, string DeviceSecret)
{
    /// <summary>Vollstaendiger Wert fuer den Authorization-Header.</summary>
    public string Token => $"{DeviceId}.{DeviceSecret}";
}

/// <summary>
/// Legt die Geraeteidentitaet unter <c>%ProgramData%</c> ab, verschluesselt mit
/// DPAPI im Maschinenkontext.
///
/// Der Maschinenkontext ist noetig, weil der Agent spaeter als Dienst unter
/// LocalSystem laeuft und die Datei nicht an ein Benutzerprofil gebunden sein
/// darf. Das bedeutet zugleich: jeder Prozess auf diesem Rechner koennte sie
/// entschluesseln. Der Schutz gegen Auslesen kommt deshalb aus den
/// Dateirechten, DPAPI schuetzt gegen das blosse Kopieren auf einen anderen
/// Rechner. Ein kompromittiertes Geraet laesst sich im Frontend sperren — das
/// ist der eigentliche Notausgang.
/// </summary>
public sealed class DeviceIdentityStore(string dataDirectory)
{
    private readonly string _identityPath = Path.Combine(dataDirectory, "identity.dat");
    private readonly string _statePath = Path.Combine(dataDirectory, "state.json");

    /// <summary>
    /// Zusatzentropie fuer DPAPI. Kein Geheimnis — der Wert steht im Binary —
    /// aber er verhindert, dass ein beliebiger anderer DPAPI-Nutzer auf dem
    /// Rechner die Datei versehentlich entschluesselt.
    /// </summary>
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("WiUpMo.Agent.Identity.v1");

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    public void EnsureDirectory() => Directory.CreateDirectory(dataDirectory);

    public DeviceIdentity? TryLoad()
    {
        if (!File.Exists(_identityPath))
        {
            return null;
        }

        try
        {
            byte[] protectedBytes = File.ReadAllBytes(_identityPath);
            byte[] plain = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.LocalMachine);
            return JsonSerializer.Deserialize<DeviceIdentity>(plain, JsonOptions);
        }
        catch (CryptographicException)
        {
            // Datei stammt von einem anderen Rechner oder ist beschaedigt.
            // Kein Grund zum Abbruch: ein erneutes Enrollment stellt die
            // Identitaet wieder her, das Backend erkennt das Geraet am Hostnamen
            // wieder und die Historie bleibt erhalten.
            return null;
        }
    }

    public void Save(DeviceIdentity identity)
    {
        EnsureDirectory();
        byte[] plain = JsonSerializer.SerializeToUtf8Bytes(identity, JsonOptions);
        byte[] protectedBytes = ProtectedData.Protect(plain, Entropy, DataProtectionScope.LocalMachine);
        File.WriteAllBytes(_identityPath, protectedBytes);
    }

    private sealed class AgentState
    {
        public DateTimeOffset? LastHistoryUtc { get; set; }
    }

    /// <summary>
    /// Zeitstempel des zuletzt gemeldeten Historieneintrags. Nicht
    /// verschluesselt — das ist kein Geheimnis, sondern nur ein Fortschritts-
    /// marker.
    /// </summary>
    public DateTimeOffset? GetLastHistoryTimestamp()
    {
        if (!File.Exists(_statePath))
        {
            return null;
        }

        try
        {
            AgentState? state = JsonSerializer.Deserialize<AgentState>(
                File.ReadAllText(_statePath), JsonOptions);
            return state?.LastHistoryUtc;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public void SetLastHistoryTimestamp(DateTimeOffset value)
    {
        EnsureDirectory();
        File.WriteAllText(
            _statePath,
            JsonSerializer.Serialize(new AgentState { LastHistoryUtc = value }, JsonOptions));
    }
}
