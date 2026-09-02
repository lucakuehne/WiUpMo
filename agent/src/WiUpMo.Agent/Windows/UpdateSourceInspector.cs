using Microsoft.Extensions.Logging;
using Microsoft.Win32;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Windows;

/// <summary>
/// Stellt fest, woher das Geraet seine Updates tatsaechlich bezieht.
///
/// Das ist die zentrale Kennzahl fuer die WSUS-Ablösung: erst der Vergleich
/// zwischen konfigurierter Richtlinie und tatsaechlich registriertem Dienst
/// zeigt, ob eine Migration bei einem Geraet wirklich angekommen ist.
/// </summary>
public sealed class UpdateSourceInspector(ILogger<UpdateSourceInspector> logger)
{
    private const string PolicyKey = @"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate";
    private const string PolicyAuKey = PolicyKey + @"\AU";
    private const string EnrollmentsKey = @"SOFTWARE\Microsoft\Enrollments";

    /// <summary>Feste Dienst-IDs der WUApi.</summary>
    private static readonly Guid WindowsUpdateService = new("9482f4b4-e343-43b6-b170-9a65bc822c77");

    private static readonly Guid MicrosoftUpdateService = new("7971f918-a847-4430-9279-4a52d1efe18d");
    private static readonly Guid WsusService = new("3da21691-e39d-4da6-8a4b-b43877bcb1b7");

    /// <summary>Kennzeichnet eine MDM-Verwaltung durch Intune.</summary>
    private const string MdmProviderId = "MS DM Server";

    public UpdateSourceInfo Read()
    {
        using RegistryKey hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);

        string? wsusServerUrl = ReadString(hklm, PolicyKey, "WUServer");
        int? useWuServer = ReadDword(hklm, PolicyAuKey, "UseWUServer");

        // Beide Schalter verhindern, dass ein WSUS-Client nebenbei auf
        // Microsoft Update zugreift. Einer genuegt.
        bool dualScanBlocked = ReadDword(hklm, PolicyKey, "DisableDualScan") == 1
            || ReadDword(hklm, PolicyKey, "DoNotConnectToWindowsUpdateInternetLocations") == 1;

        bool mdmEnrolled = IsMdmEnrolled(hklm);
        RegisteredService[] services = ReadRegisteredServices();

        bool wsusConfigured = !string.IsNullOrWhiteSpace(wsusServerUrl) && useWuServer == 1;

        return new UpdateSourceInfo
        {
            Source = Decide(wsusConfigured, dualScanBlocked, mdmEnrolled, services),
            WsusServerUrl = Limits.TruncateOrNull(wsusServerUrl, Limits.WsusServerUrl),
            UseWuServer = useWuServer is null ? null : useWuServer == 1,
            RegisteredServices = services.Length > 0
                ? [.. services.Take(Limits.RegisteredServices).Select(s => s.Name)]
                : null,
            MdmEnrolled = mdmEnrolled,
        };
    }

    /// <summary>
    /// Die Richtlinie schlaegt die registrierten Dienste: ist WSUS per GPO
    /// gesetzt, holt das Geraet seine Updates dort — unabhaengig davon, welche
    /// Dienste daneben noch registriert sind. Bleibt Dual Scan dabei offen,
    /// zieht Windows Feature-Updates trotzdem aus dem Internet; das ist ein
    /// eigener Zustand und keine Nebensaechlichkeit, weil solche Geraete in der
    /// Migrationsauswertung sonst falsch einsortiert werden.
    /// </summary>
    private static UpdateSourceKind Decide(
        bool wsusConfigured,
        bool dualScanBlocked,
        bool mdmEnrolled,
        RegisteredService[] services)
    {
        if (wsusConfigured)
        {
            return dualScanBlocked ? UpdateSourceKind.Wsus : UpdateSourceKind.DualScan;
        }

        if (mdmEnrolled)
        {
            return UpdateSourceKind.Intune;
        }

        if (services.Any(s => s.Id == WsusService))
        {
            return UpdateSourceKind.Wsus;
        }

        // Windows Update und Microsoft Update werden zusammengefasst: der
        // Unterschied ist nur, ob auch Office-Updates mitkommen, und fuer die
        // Migrationsauswertung zaehlt allein "nicht mehr WSUS".
        if (services.Any(s => s.Id == MicrosoftUpdateService || s.Id == WindowsUpdateService))
        {
            return UpdateSourceKind.MicrosoftUpdate;
        }

        return UpdateSourceKind.Unknown;
    }

    private readonly record struct RegisteredService(string Name, Guid Id);

    private RegisteredService[] ReadRegisteredServices()
    {
        object? manager = null;

        try
        {
            manager = Com.Create("Microsoft.Update.ServiceManager");

            return
            [
                .. Com.Enumerate(Com.TryGet(manager, "Services"), Limits.RegisteredServices)
                    .Select(ToService)
                    .Where(service => service is not null)
                    .Select(service => service!.Value)
            ];
        }
        catch (WindowsUpdateException ex)
        {
            // Kein Abbruch: die Registry-Auswertung allein reicht fuer die
            // Einordnung, die Dienstliste ist nur zusaetzlicher Kontext.
            logger.LogWarning("Registrierte Update-Dienste nicht lesbar: {Fehler}", ex.Message);
            return [];
        }
        finally
        {
            Com.Release(manager);
        }
    }

    private static RegisteredService? ToService(object service)
    {
        string? name = Com.TryGetString(service, "Name");
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        _ = Guid.TryParse(Com.TryGetString(service, "ServiceID"), out Guid id);
        return new RegisteredService(name, id);
    }

    /// <summary>
    /// Ein MDM-Enrollment liegt unter <c>Enrollments\{GUID}</c>. Entscheidend
    /// ist die Kombination aus abgeschlossenem Zustand und dem Anbieter — die
    /// Schluessel bleiben nach einem Abmelden teils zurueck.
    /// </summary>
    private static bool IsMdmEnrolled(RegistryKey hklm)
    {
        try
        {
            using RegistryKey? enrollments = hklm.OpenSubKey(EnrollmentsKey);
            if (enrollments is null)
            {
                return false;
            }

            foreach (string name in enrollments.GetSubKeyNames())
            {
                if (!Guid.TryParse(name, out _))
                {
                    continue;
                }

                using RegistryKey? enrollment = enrollments.OpenSubKey(name);
                if (enrollment is null)
                {
                    continue;
                }

                bool completed = enrollment.GetValue("EnrollmentState") as int? == 1;
                bool byMdmServer = string.Equals(
                    enrollment.GetValue("ProviderID") as string,
                    MdmProviderId,
                    StringComparison.OrdinalIgnoreCase);

                if (completed && byMdmServer)
                {
                    return true;
                }
            }

            return false;
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static string? ReadString(RegistryKey root, string path, string name)
    {
        using RegistryKey? key = root.OpenSubKey(path);
        return key?.GetValue(name) as string;
    }

    private static int? ReadDword(RegistryKey root, string path, string name)
    {
        using RegistryKey? key = root.OpenSubKey(path);
        return key?.GetValue(name) as int?;
    }
}
