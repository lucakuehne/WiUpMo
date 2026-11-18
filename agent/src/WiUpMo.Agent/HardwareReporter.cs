using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Storage;
using WiUpMo.Agent.Windows;

namespace WiUpMo.Agent;

/// <summary>
/// Entscheidet, wann die Hardware mit einem Snapshot hinausgeht.
///
/// Gelesen wird hoechstens einmal pro Stunde — die WMI-Abfragen kosten
/// Sekunden, und Hardware aendert sich selten. Mitgeschickt wird sie, wenn sich
/// etwas geaendert hat, und sonst einmal am Tag: So kommt der freie Platz auf
/// den Laufwerken nach, ohne als Aenderung zu zaehlen, und ein Backend, das die
/// Angaben verloren hat, bekommt sie wieder.
/// </summary>
public sealed class HardwareReporter(HardwareInspector inspector, SnapshotQueue queue)
{
    private const string FingerprintKey = "hardware_fingerprint";
    private const string SentAtKey = "hardware_sent_at";

    private static readonly TimeSpan ReadEvery = TimeSpan.FromHours(1);
    private static readonly TimeSpan SendAtLeastEvery = TimeSpan.FromDays(1);

    private DateTimeOffset _readAt = DateTimeOffset.MinValue;

    /// <summary>Die Hardware, wenn sie mit diesem Snapshot hinausgehen soll; sonst null.</summary>
    public HardwareInfo? ReadIfDue(DateTimeOffset now)
    {
        DateTimeOffset? sentAt = DateTimeOffset.TryParse(
            queue.GetMeta(SentAtKey), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset parsed)
            ? parsed
            : null;

        bool refreshDue = sentAt is null || now - sentAt.Value >= SendAtLeastEvery;
        if (!refreshDue && now - _readAt < ReadEvery)
        {
            return null;
        }

        _readAt = now;
        HardwareInfo? hardware = inspector.Read();
        if (hardware is null)
        {
            return null;
        }

        string fingerprint = Fingerprint(hardware);
        if (!refreshDue && queue.GetMeta(FingerprintKey) == fingerprint)
        {
            return null;
        }

        queue.SetMeta(FingerprintKey, fingerprint);
        queue.SetMeta(SentAtKey, now.ToString("O", CultureInfo.InvariantCulture));
        return hardware;
    }

    /// <summary>Alles ausser dem freien Platz: Der aendert sich staendig und kommt mit dem taeglichen Senden nach.</summary>
    private static string Fingerprint(HardwareInfo hardware)
    {
        HardwareInfo stable = new()
        {
            Manufacturer = hardware.Manufacturer,
            Model = hardware.Model,
            Family = hardware.Family,
            Sku = hardware.Sku,
            SerialNumber = hardware.SerialNumber,
            Chassis = hardware.Chassis,
            Firmware = hardware.Firmware,
            BiosVendor = hardware.BiosVendor,
            BiosVersion = hardware.BiosVersion,
            BiosDate = hardware.BiosDate,
            Processor = hardware.Processor,
            MemoryBytes = hardware.MemoryBytes,
            MemoryModules = hardware.MemoryModules,
            Disks = hardware.Disks,
            Volumes = hardware.Volumes?.Select(volume => new HardwareVolume
            {
                Drive = volume.Drive,
                Label = volume.Label,
                FileSystem = volume.FileSystem,
                SizeBytes = volume.SizeBytes,
                BitLocker = volume.BitLocker,
            }).ToList(),
            Tpm = hardware.Tpm,
            SecureBoot = hardware.SecureBoot,
            Graphics = hardware.Graphics,
            // Ohne Verbindungszustand und Geschwindigkeit: Die wechseln mit jedem
            // Netzwechsel und waeren sonst jedes Mal eine Aenderung.
            NetworkAdapters = hardware.NetworkAdapters?.Select(adapter => new HardwareNetworkAdapter
            {
                Name = adapter.Name,
                Connection = adapter.Connection,
                MacAddress = adapter.MacAddress,
                Kind = adapter.Kind,
            }).ToList(),
            Monitors = hardware.Monitors,
            Battery = hardware.Battery,
        };

        byte[] json = JsonSerializer.SerializeToUtf8Bytes(stable, AgentJson.Options);
        return Convert.ToHexString(SHA256.HashData(json));
    }
}
