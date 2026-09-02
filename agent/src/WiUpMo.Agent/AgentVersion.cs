using System.Reflection;

namespace WiUpMo.Agent;

/// <summary>
/// Die gemeldete Agent-Version. Sie steht im Snapshot und spaeter, ab Phase 6,
/// entscheidet das Backend daran, ob ein Selbst-Update faellig ist.
/// </summary>
public static class AgentVersion
{
    public static string Current { get; } = Read();

    private static string Read()
    {
        Assembly assembly = typeof(AgentVersion).Assembly;

        string? raw = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString();

        if (string.IsNullOrWhiteSpace(raw))
        {
            return "0.0.0";
        }

        // Der SDK haengt an die InformationalVersion einen "+<commit>"-Anhang.
        // Der gehoert nicht in die Datenbank, dort steht eine Versionsnummer.
        int plus = raw.IndexOf('+', StringComparison.Ordinal);
        return Limits.Truncate(plus > 0 ? raw[..plus] : raw, Limits.AgentVersion);
    }
}
