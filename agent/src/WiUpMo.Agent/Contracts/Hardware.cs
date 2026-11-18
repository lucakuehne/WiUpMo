namespace WiUpMo.Agent.Contracts;

/// <summary>
/// Was fuer ein Geraet es ist und was darin steckt. Ab 0.10.0.
///
/// Geht nicht mit jedem Check-in mit, sondern wenn sich etwas geaendert hat und
/// sonst einmal am Tag (siehe <c>HardwareReporter</c>). Alles ist optional und
/// nichts <c>required</c>: Was sich nicht lesen liess, fehlt, und ein
/// weggelassenes Pflichtfeld liesse den Snapshot beim Lesen aus der
/// Warteschlange durchfallen — so geschehen in 0.9.2.
/// </summary>
public sealed class HardwareInfo
{
    public string? Manufacturer { get; init; }

    /// <summary>Modellbezeichnung laut Hersteller, bei Lenovo etwa die Maschinentyp-Nummer.</summary>
    public string? Model { get; init; }

    /// <summary>Produktfamilie, bei Lenovo der lesbare Name („ThinkPad T14 Gen 4“).</summary>
    public string? Family { get; init; }

    public string? Sku { get; init; }
    public string? SerialNumber { get; init; }

    /// <summary><c>notebook</c>, <c>desktop</c>, <c>tablet</c>, <c>server</c>, <c>virtual</c> oder <c>other</c>.</summary>
    public string? Chassis { get; init; }

    /// <summary><c>uefi</c> oder <c>bios</c>.</summary>
    public string? Firmware { get; init; }

    public string? BiosVendor { get; init; }
    public string? BiosVersion { get; init; }
    public DateTimeOffset? BiosDate { get; init; }

    public HardwareProcessor? Processor { get; init; }

    /// <summary>Eingebauter Arbeitsspeicher, Summe der Module.</summary>
    public long? MemoryBytes { get; init; }

    public IReadOnlyList<HardwareMemoryModule>? MemoryModules { get; init; }
    public IReadOnlyList<HardwareDisk>? Disks { get; init; }
    public IReadOnlyList<HardwareVolume>? Volumes { get; init; }
    public HardwareTpm? Tpm { get; init; }
    public bool? SecureBoot { get; init; }
    public IReadOnlyList<HardwareGraphics>? Graphics { get; init; }
    public IReadOnlyList<HardwareNetworkAdapter>? NetworkAdapters { get; init; }
    public IReadOnlyList<HardwareMonitor>? Monitors { get; init; }
    public HardwareBattery? Battery { get; init; }
}

public sealed class HardwareProcessor
{
    public string? Name { get; init; }
    public int? Cores { get; init; }
    public int? LogicalProcessors { get; init; }
    public int? MaxClockMhz { get; init; }

    /// <summary>Anzahl der Prozessoren, bei Arbeitsplaetzen fast immer 1.</summary>
    public int? Count { get; init; }
}

public sealed class HardwareMemoryModule
{
    /// <summary>Steckplatz laut SMBIOS, etwa <c>DIMM 0</c> oder <c>ChannelA-DIMM0</c>.</summary>
    public string? Slot { get; init; }

    /// <summary>Speichertyp, etwa <c>DDR4</c> oder <c>LPDDR5</c>.</summary>
    public string? Type { get; init; }

    public long? CapacityBytes { get; init; }
    public int? SpeedMhz { get; init; }
    public string? Manufacturer { get; init; }
    public string? PartNumber { get; init; }
}

public sealed class HardwareDisk
{
    public string? Model { get; init; }
    public long? SizeBytes { get; init; }

    /// <summary><c>ssd</c>, <c>hdd</c>, <c>scm</c> oder <c>unknown</c>.</summary>
    public string? MediaType { get; init; }

    /// <summary>Anschluss, etwa <c>NVMe</c> oder <c>SATA</c>.</summary>
    public string? BusType { get; init; }
}

public sealed class HardwareVolume
{
    /// <summary>Laufwerksbuchstabe mit Doppelpunkt, etwa <c>C:</c>.</summary>
    public string? Drive { get; init; }

    public string? Label { get; init; }
    public string? FileSystem { get; init; }
    public long? SizeBytes { get; init; }

    /// <summary>Freier Platz beim Erfassen; zaehlt nicht als Aenderung der Hardware.</summary>
    public long? FreeBytes { get; init; }

    /// <summary><c>on</c>, <c>off</c>, <c>suspended</c>, <c>encrypting</c> oder <c>decrypting</c>; fehlt, wenn unbekannt.</summary>
    public string? BitLocker { get; init; }
}

public sealed class HardwareTpm
{
    public bool? Present { get; init; }

    /// <summary>Spezifikation, etwa <c>2.0</c>.</summary>
    public string? Version { get; init; }

    public bool? Enabled { get; init; }
    public bool? Activated { get; init; }
    public string? Manufacturer { get; init; }
}

public sealed class HardwareGraphics
{
    public string? Name { get; init; }
    public string? DriverVersion { get; init; }
}

public sealed class HardwareNetworkAdapter
{
    /// <summary>Bezeichnung des Adapters laut Treiber.</summary>
    public string? Name { get; init; }

    /// <summary>Name der Verbindung in Windows, etwa „WLAN“.</summary>
    public string? Connection { get; init; }

    public string? MacAddress { get; init; }

    /// <summary><c>wifi</c>, <c>ethernet</c>, <c>bluetooth</c>, <c>mobile</c> oder <c>other</c>.</summary>
    public string? Kind { get; init; }

    public bool? Connected { get; init; }
    public long? SpeedBitsPerSecond { get; init; }
}

public sealed class HardwareMonitor
{
    /// <summary>Herstellerkuerzel aus der EDID, etwa <c>DEL</c>.</summary>
    public string? Manufacturer { get; init; }

    public string? Name { get; init; }
    public string? SerialNumber { get; init; }
    public int? Year { get; init; }

    /// <summary>Eingebaut, etwa das Display eines Notebooks.</summary>
    public bool? Internal { get; init; }
}

public sealed class HardwareBattery
{
    public string? Name { get; init; }
    public string? Manufacturer { get; init; }
    public long? DesignCapacityMwh { get; init; }
    public long? FullChargeCapacityMwh { get; init; }
    public int? CycleCount { get; init; }
}
