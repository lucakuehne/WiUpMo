using System.Globalization;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;
using WiUpMo.Agent.Contracts;

namespace WiUpMo.Agent.Windows;

/// <summary>
/// Stammdaten des Rechners und der Neustart-Status.
/// </summary>
public sealed class HostInspector(ILogger<HostInspector> logger)
{
    private const string CurrentVersion = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    private const string ComponentBasedServicing =
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending";

    private const string AutoUpdateReboot =
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired";

    /// <summary>Ab diesem Build heisst das System Windows 11.</summary>
    private const int FirstWindows11Build = 22000;

    public HostInfo Read()
    {
        // Ausdruecklich die 64-Bit-Sicht: unter einem 32-Bit-Prozess landete
        // man sonst in der WOW6432Node-Umleitung und laese veraltete Werte.
        using RegistryKey hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using RegistryKey? key = hklm.OpenSubKey(CurrentVersion);

        string? productName = key?.GetValue("ProductName") as string;
        string? displayVersion = key?.GetValue("DisplayVersion") as string
            ?? key?.GetValue("ReleaseId") as string;
        string? currentBuild = key?.GetValue("CurrentBuild") as string;
        int? ubr = key?.GetValue("UBR") as int?;

        int build = int.TryParse(currentBuild, CultureInfo.InvariantCulture, out int parsed) ? parsed : 0;

        return new HostInfo
        {
            Hostname = Limits.Truncate(Environment.MachineName, Limits.Hostname),
            OsName = Limits.TruncateOrNull(CorrectProductName(productName, build), Limits.OsName),
            OsVersion = Limits.TruncateOrNull(displayVersion, Limits.OsVersion),
            OsBuild = Limits.TruncateOrNull(FormatBuild(currentBuild, ubr), Limits.OsBuild),

            // Bleibt in Phase 1 leer; die Zuordnung zum AD-Computerkonto stellt
            // der AD-Abgleich des Backends her (Phase 3).
            AdObjectGuid = null,
        };
    }

    /// <summary>
    /// Auf Windows 11 steht in <c>ProductName</c> weiterhin "Windows 10" — ein
    /// bekannter Fehler von Microsoft, der nie korrigiert wurde. Ohne diese
    /// Korrektur waere die Auswertung "Verteilung OS-Build" unbrauchbar.
    /// </summary>
    private static string? CorrectProductName(string? productName, int build)
    {
        if (string.IsNullOrWhiteSpace(productName))
        {
            return null;
        }

        return build >= FirstWindows11Build
            ? productName.Replace("Windows 10", "Windows 11", StringComparison.OrdinalIgnoreCase)
            : productName;
    }

    /// <summary>
    /// Build und Revision zusammen, etwa <c>26100.2314</c>. Erst die Revision
    /// macht sichtbar, wer beim monatlichen kumulativen Update haengengeblieben
    /// ist — die reine Build-Nummer aendert sich dabei nicht.
    /// </summary>
    private static string? FormatBuild(string? currentBuild, int? ubr)
    {
        if (string.IsNullOrWhiteSpace(currentBuild))
        {
            return null;
        }

        return ubr is null
            ? currentBuild
            : $"{currentBuild}.{ubr.Value.ToString(CultureInfo.InvariantCulture)}";
    }

    /// <summary>
    /// Drei Quellen, verodert. Die WUApi kennt nur Neustarts, die aus einem
    /// Update-Vorgang stammen; die beiden Registry-Schluessel fangen die Faelle
    /// ab, in denen das Servicing-Stack den Neustart vorgemerkt hat.
    ///
    /// <c>PendingFileRenameOperations</c> bleibt bewusst aussen vor: den setzt
    /// nahezu jede Softwareinstallation, das Ergebnis waere fast immer "true"
    /// und die Auswertung damit wertlos.
    /// </summary>
    public bool IsRebootPending()
    {
        using RegistryKey hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);

        if (KeyExists(hklm, ComponentBasedServicing) || KeyExists(hklm, AutoUpdateReboot))
        {
            return true;
        }

        object? systemInfo = null;
        try
        {
            systemInfo = Com.Create("Microsoft.Update.SystemInfo");
            return Com.TryGetBool(systemInfo, "RebootRequired");
        }
        catch (WindowsUpdateException ex)
        {
            logger.LogWarning("Neustart-Status nicht ueber WUApi ermittelbar: {Fehler}", ex.Message);
            return false;
        }
        finally
        {
            Com.Release(systemInfo);
        }
    }

    private static bool KeyExists(RegistryKey root, string path)
    {
        try
        {
            using RegistryKey? key = root.OpenSubKey(path);
            return key is not null;
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
