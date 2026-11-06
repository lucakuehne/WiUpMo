using System.Text;
using System.Text.Json;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Was der Dienst der Meldung in der Sitzung des Benutzers schickt.
///
/// Die Meldung rechnet nichts selbst aus: Wahlmoeglichkeiten und Zeiten kommen
/// fertig, sie zeigt nur an und meldet die Wahl zurueck. So bleibt die Logik an
/// einer Stelle — im Dienst, der den Neustart auch ausfuehrt.
/// </summary>
public sealed class PromptRequest
{
    /// <summary>Grund aus dem Auftrag; null fuer den Standardtext.</summary>
    public string? Reason { get; init; }

    /// <summary>Zusaetzlicher Text der IT.</summary>
    public string? Message { get; init; }

    /// <summary>Spaetestens dann wird neu gestartet.</summary>
    public DateTimeOffset Deadline { get; init; }

    /// <summary>Nicht mehr verschiebbar: gleich der letzte Countdown.</summary>
    public bool Final { get; init; }

    public int CountdownMinutes { get; init; } = 10;

    public int DeferralsLeft { get; init; }

    public List<PromptOption> Options { get; init; } = [];
}

/// <summary>Eine Wahl zum Verschieben, etwa „4 Stunden" oder „bis morgen, 08:00 Uhr".</summary>
public sealed class PromptOption
{
    public required string Label { get; init; }
    public required DateTimeOffset Until { get; init; }

    /// <summary>Fuer die Auswahlliste der Meldung.</summary>
    public override string ToString() => Label;
}

/// <summary>Die Wahl des Benutzers: <c>now</c>, <c>defer</c> bis <see cref="Until"/> oder <c>timeout</c>.</summary>
public sealed class PromptAnswer
{
    public required string Choice { get; init; }
    public DateTimeOffset? Until { get; init; }
}

/// <summary>Eine Zeile JSON je Nachricht, UTF-8 ohne BOM.</summary>
internal static class PromptJson
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public static readonly Encoding Encoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
}
