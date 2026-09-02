namespace WiUpMo.Agent;

/// <summary>
/// Laengenobergrenzen aus den Backend-DTOs. Der Agent kuerzt selbst, statt sich
/// auf die serverseitige Pruefung zu verlassen: dort fuehrt ein zu langer Titel
/// dazu, dass der <em>gesamte</em> Snapshot abgelehnt wird. Ein gekuerzter Titel
/// ist der deutlich kleinere Schaden.
/// </summary>
internal static class Limits
{
    public const int Title = 1024;
    public const int UpdateId = 128;
    public const int KbArticle = 32;
    public const int Severity = 32;
    public const int MsrcNumber = 64;
    public const int SizeBytes = 32;
    public const int SupportUrl = 2048;
    public const int WsusServerUrl = 1024;
    public const int AgentVersion = 32;
    public const int Hostname = 255;
    public const int OsName = 255;
    public const int OsVersion = 64;
    public const int OsBuild = 64;

    /// <summary>Maximale Anzahl registrierter Dienste im Snapshot.</summary>
    public const int RegisteredServices = 20;

    /// <summary>Obergrenze fuer <c>availableUpdates</c> und <c>history</c>.</summary>
    public const int ArrayItems = 2000;

    public static string Truncate(string value, int maxLength) =>
        value.Length <= maxLength ? value : value[..maxLength];

    public static string? TruncateOrNull(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }
}
