using System.Text;
using System.Text.RegularExpressions;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Der Text der Meldung aus den Einstellungen, mit Platzhaltern wie
/// <c>{grund}</c> oder <c>{frist}</c>.
///
/// Eine Zeile, deren Platzhalter alle leer bleiben, faellt ganz weg — so
/// verschwindet „Grund: {grund}", wenn kein Grund angegeben ist. Unbekannte
/// Platzhalter bleiben stehen, mehrere Leerzeilen werden zu einer. Dieselbe
/// Regel steht fuer die Vorschau in den Einstellungen im Frontend
/// (<c>restart-prompt.ts</c>).
/// </summary>
public static partial class PromptTemplate
{
    /// <summary>Was ohne Text aus den Einstellungen gilt — ein Backend vor 0.9.1.</summary>
    public const string Default = "Grund: {grund}";

    [GeneratedRegex(@"\{(\w+)\}")]
    private static partial Regex Placeholder();

    [GeneratedRegex(@"\n{3,}")]
    private static partial Regex BlankLines();

    public static string Render(string template, IReadOnlyDictionary<string, string> values)
    {
        var lines = new List<string>();

        foreach (string line in template.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            List<string> names = [.. Placeholder().Matches(line).Select(m => m.Groups[1].Value).Where(values.ContainsKey)];
            if (names.Count > 0 && names.TrueForAll(name => string.IsNullOrEmpty(values[name])))
            {
                continue;
            }

            lines.Add(Placeholder().Replace(
                line,
                match => values.TryGetValue(match.Groups[1].Value, out string? value) ? value : match.Value));
        }

        return BlankLines().Replace(string.Join('\n', lines), "\n\n").Trim();
    }

    /// <summary>
    /// Der Text fuer einen Auftrag: aus den Einstellungen, oder — von einem
    /// Backend bis 0.9.0 — der Grund mit dem damaligen Zusatztext darunter.
    /// </summary>
    public static string For(Contracts.RestartRequest request)
    {
        if (request.PromptText is not null)
        {
            return request.PromptText;
        }

        var text = new StringBuilder(Default);
        if (!string.IsNullOrWhiteSpace(request.Message))
        {
            text.Append("\n\n").Append(request.Message.Trim());
        }

        return text.ToString();
    }
}
