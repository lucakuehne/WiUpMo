namespace WiUpMo.Agent;

/// <summary>
/// Bewusst minimal: in Phase 1 laeuft der Agent als einmaliger Konsolenaufruf,
/// da genuegt eine Zeile auf stdout. Serilog mit rollierender Datei und das
/// Windows-Ereignisprotokoll kommen mit dem Dienstbetrieb in Phase 2 dazu.
/// </summary>
public static class Log
{
    private static readonly Lock Gate = new();

    public static void Info(string message) => Write("INF", message);

    public static void Warn(string message) => Write("WRN", message);

    public static void Error(string message) => Write("ERR", message);

    private static void Write(string level, string message)
    {
        // Ortszeit, nicht UTC: die Ausgabe liest ein Mensch, der neben dem
        // Rechner sitzt. Alles, was gespeichert wird, ist dagegen UTC.
        string line = $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss} [{level}] {message}";
        lock (Gate)
        {
            Console.WriteLine(line);
        }
    }
}
