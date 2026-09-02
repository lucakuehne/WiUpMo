using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Storage;

public sealed record QueuedSnapshot(long Id, Snapshot Snapshot);

/// <summary>
/// Dauerhafte Warteschlange unter <c>%ProgramData%\WiUpMo\queue.db</c>.
///
/// Jeder Snapshot wird zuerst hier abgelegt und erst danach gesendet. Das ist
/// der Kern des Offline-Betriebs: ein Laptop, der wochenlang nicht ins
/// Firmennetz kommt, sammelt seine Meldungen und reicht sie geschlossen nach,
/// sobald er wieder erreichbar ist.
///
/// Der Fortschrittsmarker der Historie liegt in derselben Datenbank und wird in
/// derselben Transaktion fortgeschrieben wie der Snapshot. Laege er daneben,
/// koennte ein Absturz zwischen beiden Schreibvorgaengen dazu fuehren, dass
/// Historieneintraege ein zweites Mal gemeldet werden — und weil
/// <c>device_update_events</c> im Backend rein anhaengend ist, entstuenden
/// daraus doppelte Ereignisse in der Zeitreihe.
/// </summary>
public sealed class SnapshotQueue(AgentOptions options, ILogger<SnapshotQueue> logger) : IDisposable
{
    private const string LastHistoryKey = "last_history_utc";

    private SqliteConnection? _connection;

    private SqliteConnection Connection =>
        _connection ?? throw new InvalidOperationException("Die Warteschlange wurde nicht geoeffnet.");

    public void Open()
    {
        Directory.CreateDirectory(options.DataDirectory);

        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(options.DataDirectory, "queue.db"),
            Mode = SqliteOpenMode.ReadWriteCreate,
        };

        _connection = new SqliteConnection(builder.ConnectionString);
        _connection.Open();

        // WAL, damit ein abrupter Stromausfall waehrend des Schreibens die Datei
        // nicht beschaedigt.
        Execute("PRAGMA journal_mode=WAL;");
        Execute("PRAGMA synchronous=NORMAL;");

        Execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id  TEXT NOT NULL UNIQUE,
                collected_at TEXT NOT NULL,
                payload      TEXT NOT NULL
            );
            """);
        Execute("CREATE INDEX IF NOT EXISTS idx_snapshots_collected ON snapshots(collected_at);");
        Execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    }

    /// <summary>
    /// Legt den Snapshot ab und setzt den Fortschrittsmarker in einem Zug.
    /// </summary>
    public void Enqueue(Snapshot snapshot)
    {
        string payload = JsonSerializer.Serialize(snapshot, AgentJson.Options);

        using SqliteTransaction transaction = Connection.BeginTransaction();

        using (SqliteCommand insert = Connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT OR IGNORE INTO snapshots (snapshot_id, collected_at, payload)
                VALUES ($id, $collected, $payload);
                """;
            insert.Parameters.AddWithValue("$id", snapshot.SnapshotId.ToString());
            insert.Parameters.AddWithValue("$collected", Format(snapshot.CollectedAt));
            insert.Parameters.AddWithValue("$payload", payload);
            insert.ExecuteNonQuery();
        }

        using (SqliteCommand marker = Connection.CreateCommand())
        {
            marker.Transaction = transaction;
            marker.CommandText = """
                INSERT INTO meta (key, value) VALUES ($key, $value)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value;
                """;
            marker.Parameters.AddWithValue("$key", LastHistoryKey);
            marker.Parameters.AddWithValue("$value", Format(snapshot.CollectedAt));
            marker.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    /// <summary>Aelteste zuerst — die Reihenfolge bestimmt die Zustandsuebergaenge im Backend.</summary>
    public IReadOnlyList<QueuedSnapshot> Peek(int limit)
    {
        using SqliteCommand command = Connection.CreateCommand();
        command.CommandText = """
            SELECT id, payload FROM snapshots
             ORDER BY collected_at ASC, id ASC
             LIMIT $limit;
            """;
        command.Parameters.AddWithValue("$limit", limit);

        var result = new List<QueuedSnapshot>();
        using SqliteDataReader reader = command.ExecuteReader();

        while (reader.Read())
        {
            long id = reader.GetInt64(0);
            string payload = reader.GetString(1);

            Snapshot? snapshot;
            try
            {
                snapshot = JsonSerializer.Deserialize<Snapshot>(payload, AgentJson.Options);
            }
            catch (JsonException ex)
            {
                // Der Eintrag stammt aus einer aelteren Agent-Version mit
                // anderem Format. Er ist nicht zu retten und blockiert sonst
                // die ganze Warteschlange.
                logger.LogWarning("Verwerfe unlesbaren Warteschlangeneintrag {Id}: {Fehler}", id, ex.Message);
                snapshot = null;
            }

            if (snapshot is null)
            {
                Remove([id]);
                continue;
            }

            result.Add(new QueuedSnapshot(id, snapshot));
        }

        return result;
    }

    public void Remove(IReadOnlyCollection<long> ids)
    {
        if (ids.Count == 0)
        {
            return;
        }

        using SqliteTransaction transaction = Connection.BeginTransaction();

        foreach (long id in ids)
        {
            using SqliteCommand command = Connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "DELETE FROM snapshots WHERE id = $id;";
            command.Parameters.AddWithValue("$id", id);
            command.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    public int Count()
    {
        using SqliteCommand command = Connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM snapshots;";
        return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Kappt die Warteschlange auf Anzahl und Alter. Verworfen wird immer das
    /// Aelteste: der juengste Snapshot beschreibt den aktuellen Zustand des
    /// Geraets und ist damit der wertvollste.
    /// </summary>
    public int Prune()
    {
        string cutoff = Format(DateTimeOffset.UtcNow.AddDays(-options.QueueMaxAgeDays));

        using SqliteCommand byAge = Connection.CreateCommand();
        byAge.CommandText = "DELETE FROM snapshots WHERE collected_at < $cutoff;";
        byAge.Parameters.AddWithValue("$cutoff", cutoff);
        int removed = byAge.ExecuteNonQuery();

        using SqliteCommand byCount = Connection.CreateCommand();
        byCount.CommandText = """
            DELETE FROM snapshots WHERE id NOT IN (
                SELECT id FROM snapshots ORDER BY collected_at DESC, id DESC LIMIT $keep
            );
            """;
        byCount.Parameters.AddWithValue("$keep", options.QueueMaxSnapshots);
        removed += byCount.ExecuteNonQuery();

        return removed;
    }

    public DateTimeOffset? GetLastHistoryTimestamp()
    {
        using SqliteCommand command = Connection.CreateCommand();
        command.CommandText = "SELECT value FROM meta WHERE key = $key;";
        command.Parameters.AddWithValue("$key", LastHistoryKey);

        return command.ExecuteScalar() is string value
            && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTimeOffset parsed)
            ? parsed
            : null;
    }

    /// <summary>
    /// Uebernimmt den Marker aus der <c>state.json</c> der Phase 1, sofern die
    /// Datenbank noch keinen hat. Ohne das laese ein aktualisierter Agent die
    /// Historie erneut ueber den gesamten Anfangszeitraum ein und meldete alles
    /// ein zweites Mal.
    /// </summary>
    public void ImportLegacyMarker(DateTimeOffset? legacy)
    {
        if (legacy is null || GetLastHistoryTimestamp() is not null)
        {
            return;
        }

        using SqliteCommand command = Connection.CreateCommand();
        command.CommandText = "INSERT OR IGNORE INTO meta (key, value) VALUES ($key, $value);";
        command.Parameters.AddWithValue("$key", LastHistoryKey);
        command.Parameters.AddWithValue("$value", Format(legacy.Value));
        command.ExecuteNonQuery();

        logger.LogInformation("Fortschrittsmarker aus der Vorgaengerversion uebernommen: {Marker:u}.", legacy.Value);
    }

    private static string Format(DateTimeOffset value) =>
        value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);

    private void Execute(string sql)
    {
        using SqliteCommand command = Connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    public void Dispose()
    {
        _connection?.Dispose();
        _connection = null;
    }
}
