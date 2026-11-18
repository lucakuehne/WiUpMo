using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Windows;

/// <summary>
/// Liest die Hardware des Geraets: Modell, Prozessor, Speicher, Datentraeger,
/// Sicherheit (TPM, Secure Boot, BitLocker) und weitere Komponenten.
///
/// Jeder Bereich fuer sich: Fehlt ein WMI-Namensraum — auf virtuellen
/// Maschinen etwa der fuer das TPM — oder scheitert eine Abfrage, fehlt nur
/// dieser Teil. Das Ganze laeuft unter <see cref="HangGuard.Wmi"/>: Ein
/// haengender WMI-Anbieter haelt den Durchlauf nicht auf.
/// </summary>
public sealed class HardwareInspector(ILogger<HardwareInspector> logger)
{
    private static readonly TimeSpan Limit = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan QueryTimeout = TimeSpan.FromSeconds(30);

    private const string Cimv2 = @"root\cimv2";
    private const string Storage = @"root\Microsoft\Windows\Storage";
    private const string StandardCimv2 = @"root\StandardCimv2";
    private const string Tpm = @"root\cimv2\Security\MicrosoftTpm";
    private const string VolumeEncryption = @"root\cimv2\Security\MicrosoftVolumeEncryption";
    private const string Wmi = @"root\wmi";

    private const int MaxItems = 16;
    private const int Text = 256;
    private const int Short = 64;

    /// <summary>Die Hardware; null, wenn WMI gar nicht antwortet.</summary>
    public HardwareInfo? Read()
    {
        try
        {
            return HangGuard.Wmi.Run(ReadNow, Limit, "Die Abfrage der Hardware");
        }
        catch (WindowsUpdateException ex)
        {
            logger.LogWarning("Hardware nicht lesbar: {Fehler}", ex.Message);
            return null;
        }
    }

    private HardwareInfo ReadNow()
    {
        Row? system = Section("Computer", () => Rows(Cimv2, "Win32_ComputerSystem",
            "Manufacturer", "Model", "SystemFamily", "SystemSKUNumber", "PCSystemType", "TotalPhysicalMemory").FirstOrDefault());
        Row? bios = Section("BIOS", () => Rows(Cimv2, "Win32_BIOS",
            "SerialNumber", "SMBIOSBIOSVersion", "Manufacturer", "ReleaseDate").FirstOrDefault());
        Row? enclosure = Section("Gehaeuse", () => Rows(Cimv2, "Win32_SystemEnclosure", "ChassisTypes").FirstOrDefault());
        List<HardwareMemoryModule>? modules = Section("Arbeitsspeicher", ReadMemoryModules);

        string? manufacturer = Clean(system?.String("Manufacturer"), Text);
        string? model = Clean(system?.String("Model"), Text);
        long? installed = modules is { Count: > 0 } && modules.All(m => m.CapacityBytes is not null)
            ? modules.Sum(m => m.CapacityBytes!.Value)
            : system?.Long("TotalPhysicalMemory");

        return new HardwareInfo
        {
            Manufacturer = manufacturer,
            Model = model,
            Family = Clean(system?.String("SystemFamily"), Text),
            Sku = Clean(system?.String("SystemSKUNumber"), Text),
            SerialNumber = Clean(bios?.String("SerialNumber"), Short),
            Chassis = Chassis(enclosure?.UShorts("ChassisTypes"), system?.Int("PCSystemType"), manufacturer, model),
            Firmware = Firmware(),
            BiosVendor = Clean(bios?.String("Manufacturer"), Short),
            BiosVersion = Clean(bios?.String("SMBIOSBIOSVersion"), Short),
            BiosDate = CimDate(bios?.String("ReleaseDate")),
            Processor = Section("Prozessor", ReadProcessor),
            MemoryBytes = installed,
            MemoryModules = modules is { Count: > 0 } ? modules : null,
            Disks = NullIfEmpty(Section("Datentraeger", ReadDisks)),
            Volumes = NullIfEmpty(Section("Laufwerke", ReadVolumes)),
            Tpm = Section("TPM", ReadTpm),
            SecureBoot = SecureBoot(),
            Graphics = NullIfEmpty(Section("Grafik", ReadGraphics)),
            NetworkAdapters = NullIfEmpty(Section("Netzwerk", ReadNetworkAdapters)),
            Monitors = NullIfEmpty(Section("Monitore", ReadMonitors)),
            Battery = Section("Akku", ReadBattery),
        };
    }

    // --- Bereiche --------------------------------------------------------------------

    private static HardwareProcessor? ReadProcessor()
    {
        List<Row> cpus = Rows(Cimv2, "Win32_Processor", "Name", "NumberOfCores", "NumberOfLogicalProcessors", "MaxClockSpeed");
        Row? first = cpus.FirstOrDefault();
        if (first is null)
        {
            return null;
        }

        return new HardwareProcessor
        {
            // Intel fuellt den Namen mit Leerzeichen auf.
            Name = Clean(string.Join(' ', (first.String("Name") ?? string.Empty).Split(' ', StringSplitOptions.RemoveEmptyEntries)), Text),
            Cores = first.Int("NumberOfCores"),
            LogicalProcessors = first.Int("NumberOfLogicalProcessors"),
            MaxClockMhz = first.Int("MaxClockSpeed"),
            Count = cpus.Count,
        };
    }

    private static List<HardwareMemoryModule> ReadMemoryModules() =>
    [
        .. Rows(Cimv2, "Win32_PhysicalMemory",
                "DeviceLocator", "SMBIOSMemoryType", "Capacity", "Speed", "ConfiguredClockSpeed", "Manufacturer", "PartNumber")
            .Take(MaxItems)
            .Select(row => new HardwareMemoryModule
            {
                Slot = Clean(row.String("DeviceLocator"), Short),
                Type = MemoryType(row.Int("SMBIOSMemoryType")),
                CapacityBytes = row.Long("Capacity"),
                SpeedMhz = row.Int("ConfiguredClockSpeed") is > 0 and int configured ? configured : row.Int("Speed"),
                Manufacturer = Clean(row.String("Manufacturer"), Short),
                PartNumber = Clean(row.String("PartNumber"), Short),
            }),
    ];

    /// <summary>
    /// Die eingebauten Datentraeger. USB, SD-Karten und virtuelle Platten
    /// fallen heraus — sie kaemen und gingen und waeren jedes Mal eine Aenderung.
    /// </summary>
    private static List<HardwareDisk> ReadDisks()
    {
        int[] removable = [7, 12, 13, 15];

        return
        [
            .. Rows(Storage, "MSFT_PhysicalDisk", "FriendlyName", "Size", "MediaType", "BusType")
                .Where(row => row.Int("BusType") is not int bus || !removable.Contains(bus))
                .Take(MaxItems)
                .Select(row => new HardwareDisk
                {
                    Model = Clean(row.String("FriendlyName"), Text),
                    SizeBytes = row.Long("Size"),
                    MediaType = row.Int("MediaType") switch
                    {
                        3 => "hdd",
                        4 => "ssd",
                        5 => "scm",
                        _ => "unknown",
                    },
                    BusType = row.Int("BusType") switch
                    {
                        1 => "SCSI",
                        3 => "ATA",
                        8 => "RAID",
                        9 => "iSCSI",
                        10 => "SAS",
                        11 => "SATA",
                        17 => "NVMe",
                        _ => null,
                    },
                }),
        ];
    }

    /// <summary>Feste Laufwerke mit Groesse, freiem Platz und BitLocker-Zustand.</summary>
    private List<HardwareVolume> ReadVolumes()
    {
        Dictionary<string, string> bitLocker = Section("BitLocker", ReadBitLocker) ?? [];

        return
        [
            .. DriveInfo.GetDrives()
                .Where(drive => drive.DriveType == DriveType.Fixed && drive.IsReady)
                .Take(26)
                .Select(drive =>
                {
                    string letter = drive.Name.TrimEnd('\\');
                    return new HardwareVolume
                    {
                        Drive = Clean(letter, 8),
                        Label = Clean(drive.VolumeLabel, Text),
                        FileSystem = Clean(drive.DriveFormat, 32),
                        SizeBytes = drive.TotalSize,
                        FreeBytes = drive.TotalFreeSpace,
                        BitLocker = bitLocker.GetValueOrDefault(letter.ToUpperInvariant()),
                    };
                }),
        ];
    }

    /// <summary>Laufwerksbuchstabe → Zustand. Braucht Adminrechte; der Dienst hat sie.</summary>
    private static Dictionary<string, string> ReadBitLocker()
    {
        var states = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Row row in Rows(VolumeEncryption, "Win32_EncryptableVolume", "DriveLetter", "ProtectionStatus", "ConversionStatus"))
        {
            string? letter = row.String("DriveLetter");
            if (string.IsNullOrEmpty(letter))
            {
                continue;
            }

            string? state = (row.Int("ProtectionStatus"), row.Int("ConversionStatus")) switch
            {
                (1, _) => "on",
                (_, 2) or (_, 4) => "encrypting",
                (_, 3) or (_, 5) => "decrypting",
                (0, 1) => "suspended",
                (0, 0) => "off",
                _ => null,
            };

            if (state is not null)
            {
                states[letter.ToUpperInvariant()] = state;
            }
        }

        return states;
    }

    private static HardwareTpm ReadTpm()
    {
        Row? tpm = Rows(Tpm, "Win32_Tpm",
            "IsEnabled_InitialValue", "IsActivated_InitialValue", "SpecVersion", "ManufacturerIdTxt").FirstOrDefault();

        if (tpm is null)
        {
            return new HardwareTpm { Present = false };
        }

        // "2.0, 0, 1.59": vorn die Spezifikation.
        string? spec = tpm.String("SpecVersion")?.Split(',')[0].Trim();
        return new HardwareTpm
        {
            Present = true,
            Version = Clean(spec, 16),
            Enabled = tpm.Bool("IsEnabled_InitialValue"),
            Activated = tpm.Bool("IsActivated_InitialValue"),
            Manufacturer = Clean(tpm.String("ManufacturerIdTxt"), Short),
        };
    }

    private static List<HardwareGraphics> ReadGraphics() =>
    [
        .. Rows(Cimv2, "Win32_VideoController", "Name", "DriverVersion")
            .Take(8)
            .Select(row => new HardwareGraphics
            {
                Name = Clean(row.String("Name"), Text),
                DriverVersion = Clean(row.String("DriverVersion"), Short),
            }),
    ];

    /// <summary>Nur echte Adapter: keine virtuellen, keine VPN- und Hyper-V-Schnittstellen.</summary>
    private static List<HardwareNetworkAdapter> ReadNetworkAdapters() =>
    [
        // Jede Eigenschaft in der Liste muss es geben, sonst lehnt WMI die
        // ganze Abfrage ab — `MacAddress` etwa gibt es hier nicht.
        .. Rows(StandardCimv2, "MSFT_NetAdapter",
                "Name", "InterfaceDescription", "PermanentAddress", "NdisPhysicalMedium",
                "MediaConnectState", "Speed", "HardwareInterface", "Virtual")
            .Where(row => row.Bool("HardwareInterface") == true && row.Bool("Virtual") != true)
            .Take(MaxItems)
            .Select(row => new HardwareNetworkAdapter
            {
                Name = Clean(row.String("InterfaceDescription"), Text),
                Connection = Clean(row.String("Name"), Text),
                MacAddress = Clean(Mac(row.String("PermanentAddress")), 32),
                Kind = row.Long("NdisPhysicalMedium") switch
                {
                    1 or 9 => "wifi",
                    0 or 14 => "ethernet",
                    10 => "bluetooth",
                    8 => "mobile",
                    _ => "other",
                },
                Connected = row.Long("MediaConnectState") is long state ? state == 1 : null,
                SpeedBitsPerSecond = row.Long("Speed") is > 0 and long speed ? speed : null,
            }),
    ];

    private static List<HardwareMonitor> ReadMonitors()
    {
        // Eingebaute Anzeige: VideoOutputTechnology 0x80000000 (intern).
        var internalDisplays = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Row row in Rows(Wmi, "WmiMonitorConnectionParams", "InstanceName", "VideoOutputTechnology"))
        {
            if (row.Long("VideoOutputTechnology") == 0x80000000L && row.String("InstanceName") is string name)
            {
                internalDisplays.Add(name);
            }
        }

        return
        [
            .. Rows(Wmi, "WmiMonitorID", "InstanceName", "ManufacturerName", "UserFriendlyName", "SerialNumberID", "YearOfManufacture")
                .Take(8)
                .Select(row => new HardwareMonitor
                {
                    Manufacturer = Clean(Edid(row.UShorts("ManufacturerName")), Short),
                    Name = Clean(Edid(row.UShorts("UserFriendlyName")), Text),
                    SerialNumber = Clean(Edid(row.UShorts("SerialNumberID")), Short) is string serial && serial != "0" ? serial : null,
                    Year = row.Int("YearOfManufacture") is > 1990 and int year ? year : null,
                    Internal = row.String("InstanceName") is string instance && internalDisplays.Contains(instance),
                }),
        ];
    }

    private static HardwareBattery? ReadBattery()
    {
        Row? info = Rows(Wmi, "BatteryStaticData", "DeviceName", "ManufactureName", "DesignedCapacity").FirstOrDefault();
        if (info is null)
        {
            return null;
        }

        Row? full = Rows(Wmi, "BatteryFullChargedCapacity", "FullChargedCapacity").FirstOrDefault();
        Row? cycles = Rows(Wmi, "BatteryCycleCount", "CycleCount").FirstOrDefault();

        return new HardwareBattery
        {
            Name = Clean(info.String("DeviceName"), Text),
            Manufacturer = Clean(info.String("ManufactureName"), Short),
            DesignCapacityMwh = info.Long("DesignedCapacity") is > 0 and long design ? design : null,
            FullChargeCapacityMwh = full?.Long("FullChargedCapacity") is > 0 and long charged ? charged : null,
            CycleCount = cycles?.Int("CycleCount") is > 0 and int count ? count : null,
        };
    }

    // --- Registry --------------------------------------------------------------------

    /// <summary>
    /// Ueber die API statt die Registry: <c>PEFirmwareType</c> steht nicht auf
    /// jedem Geraet unter <c>Control</c>.
    /// </summary>
    private static string? Firmware() =>
        GetFirmwareType(out int type)
            ? type switch
            {
                1 => "bios",
                2 => "uefi",
                _ => null,
            }
            : null;

    /// <summary>1 = BIOS, 2 = UEFI. Ab Windows 8.</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFirmwareType(out int firmwareType);

    private static bool? SecureBoot()
    {
        using RegistryKey hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using RegistryKey? key = hklm.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\SecureBoot\State");
        return key?.GetValue("UEFISecureBootEnabled") is int enabled ? enabled == 1 : null;
    }

    // --- Hilfen ------------------------------------------------------------------------

    /// <summary>
    /// Aus SMBIOS-Gehaeusetypen und dem Systemtyp. Virtuelle Maschinen zuerst:
    /// Sie melden oft „Desktop“ oder gar nichts Brauchbares.
    /// </summary>
    private static string? Chassis(ushort[]? types, int? pcSystemType, string? manufacturer, string? model)
    {
        string identity = $"{manufacturer} {model}";
        if (identity.Contains("Virtual", StringComparison.OrdinalIgnoreCase)
            || identity.Contains("VMware", StringComparison.OrdinalIgnoreCase)
            || identity.Contains("QEMU", StringComparison.OrdinalIgnoreCase)
            || identity.Contains("Xen", StringComparison.OrdinalIgnoreCase))
        {
            return "virtual";
        }

        foreach (ushort type in types ?? [])
        {
            string? kind = type switch
            {
                8 or 9 or 10 or 14 or 31 or 32 => "notebook",
                30 => "tablet",
                3 or 4 or 5 or 6 or 7 or 13 or 15 or 16 or 35 or 36 => "desktop",
                17 or 23 or 28 => "server",
                _ => null,
            };
            if (kind is not null)
            {
                return kind;
            }
        }

        return pcSystemType switch
        {
            2 => "notebook",
            1 or 3 => "desktop",
            4 or 5 or 7 => "server",
            8 => "tablet",
            null => null,
            _ => "other",
        };
    }

    /// <summary>SMBIOS-Speichertyp (Tabelle 17); unbekannte Werte bleiben leer.</summary>
    private static string? MemoryType(int? smbiosType) => smbiosType switch
    {
        20 => "DDR",
        21 => "DDR2",
        24 => "DDR3",
        26 => "DDR4",
        27 => "LPDDR",
        28 => "LPDDR2",
        29 => "LPDDR3",
        30 => "LPDDR4",
        34 => "DDR5",
        35 => "LPDDR5",
        _ => null,
    };

    /// <summary>CIM-Datum wie <c>20250312000000.000000+000</c>; nur der Tag zaehlt.</summary>
    private static DateTimeOffset? CimDate(string? value) =>
        value is { Length: >= 8 }
        && DateTime.TryParseExact(value[..8], "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTime date)
            ? new DateTimeOffset(date, TimeSpan.Zero)
            : null;

    /// <summary>EDID-Texte kommen als Zahlenfeld, mit Nullen aufgefuellt.</summary>
    private static string? Edid(ushort[]? chars) =>
        chars is null ? null : new string(chars.TakeWhile(c => c != 0).Select(c => (char)c).ToArray());

    /// <summary><c>AABBCCDDEEFF</c> → <c>AA-BB-CC-DD-EE-FF</c>, wie Windows sie sonst zeigt.</summary>
    private static string? Mac(string? raw) =>
        raw is { Length: 12 } && raw.All(char.IsAsciiHexDigit)
            ? string.Join('-', Enumerable.Range(0, 6).Select(i => raw.Substring(i * 2, 2)))
            : null;

    private static string? Clean(string? value, int maxLength)
    {
        string? trimmed = value?.Trim();
        // Platzhalter, die Hersteller statt eines Werts eintragen.
        if (string.IsNullOrEmpty(trimmed)
            || trimmed is "To be filled by O.E.M." or "Default string" or "System Serial Number" or "None" or "0")
        {
            return null;
        }

        return Limits.TruncateOrNull(trimmed, maxLength);
    }

    private static List<T>? NullIfEmpty<T>(List<T>? items) => items is { Count: > 0 } ? items : null;

    private T? Section<T>(string what, Func<T> read)
    {
        try
        {
            return read();
        }
        catch (Exception ex) when (ex is ManagementException or COMException or UnauthorizedAccessException
                                      or InvalidOperationException or IOException or PlatformNotSupportedException
                                      or OverflowException or FormatException or InvalidCastException)
        {
            // Auf manchen Geraeten fehlt ein Namensraum ganz, etwa das TPM auf
            // einer VM. Das ist kein Fehler, der ins Protokoll gehoert.
            logger.LogDebug("Hardware, {Bereich}: {Fehler}", what, ex.Message);
            return default;
        }
    }

    private static List<Row> Rows(string scope, string className, params string[] properties)
    {
        var options = new System.Management.EnumerationOptions
        {
            Timeout = QueryTimeout,
            ReturnImmediately = true,
            Rewindable = false,
        };
        using var searcher = new ManagementObjectSearcher(
            new ManagementScope(scope),
            new SelectQuery(className, string.Empty, properties),
            options);

        var rows = new List<Row>();
        using ManagementObjectCollection results = searcher.Get();
        foreach (ManagementBaseObject item in results)
        {
            using (item)
            {
                var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
                foreach (string property in properties)
                {
                    try
                    {
                        values[property] = item[property];
                    }
                    catch (ManagementException)
                    {
                        // Die Eigenschaft gibt es auf dieser Windows-Fassung nicht.
                    }
                }

                rows.Add(new Row(values));
            }
        }

        return rows;
    }

    private sealed class Row(Dictionary<string, object?> values)
    {
        private object? Get(string name) => values.GetValueOrDefault(name);

        public string? String(string name) => Get(name)?.ToString();

        /// <summary>
        /// Auch aus <c>UInt64</c>: Manche Treiber melden dort den Hoechstwert
        /// fuer „unbekannt“, und der passt nicht in ein <c>long</c>.
        /// </summary>
        public long? Long(string name) => Get(name) switch
        {
            null => null,
            ulong big => big <= long.MaxValue ? (long)big : null,
            string text => long.TryParse(text, CultureInfo.InvariantCulture, out long parsed) ? parsed : null,
            IConvertible number => Convert.ToInt64(number, CultureInfo.InvariantCulture),
            _ => null,
        };

        public int? Int(string name) => Long(name) is long value and >= int.MinValue and <= int.MaxValue ? (int)value : null;

        public bool? Bool(string name) => Get(name) is bool value ? value : null;

        public ushort[]? UShorts(string name) => Get(name) as ushort[];
    }
}
