using System.Reflection;

namespace WiUpMo.Agent;

/// <summary>
/// Die gemeldete Agent-Version. Sie steht im Snapshot und spaeter, ab Phase 6,
/// entscheidet das Backend daran, ob ein Selbst-Update faellig ist.
/// </summary>
public static class AgentVersion
{
    public static string Current { get; } = Read();

    /// <summary>
    /// Vergleicht zwei Versionen nach ihren Zahlen, nicht als Text: 0.10.0 ist
    /// neuer als 0.9.0. Ein Anhang wie <c>-beta</c> zaehlt nicht. Was sich nicht
    /// lesen laesst, gilt als aelter als alles andere.
    /// </summary>
    public static int Compare(string? left, string? right)
    {
        int[] a = Parts(left);
        int[] b = Parts(right);

        for (int i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            int x = i < a.Length ? a[i] : 0;
            int y = i < b.Length ? b[i] : 0;
            if (x != y)
            {
                return x.CompareTo(y);
            }
        }

        return 0;

        static int[] Parts(string? version)
        {
            if (string.IsNullOrWhiteSpace(version))
            {
                return [];
            }

            string core = version.Split('-', '+')[0];
            return [.. core.Split('.').Select(part => int.TryParse(part, out int n) ? n : 0)];
        }
    }

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
