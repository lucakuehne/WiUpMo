using System.Runtime.InteropServices;
using System.Text;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Was der Dienst von Windows braucht, um dem angemeldeten Benutzer eine
/// Meldung zu zeigen: die Sitzungen aufzaehlen, das Anmeldetoken eines
/// Benutzers holen und damit einen Prozess in dessen Sitzung starten.
///
/// Der Dienst laeuft als LocalSystem in Sitzung 0 und hat keinen sichtbaren
/// Desktop. Diese Aufrufe sind der uebliche Weg hinaus; LocalSystem bringt die
/// noetigen Rechte mit.
/// </summary>
internal static class NativeMethods
{
    public const int WtsActive = 0;
    public const int WtsDisconnected = 4;

    public const uint MaximumAllowed = 0x02000000;
    public const int SecurityImpersonation = 2;
    public const int TokenPrimary = 1;
    public const uint CreateUnicodeEnvironment = 0x00000400;
    public const uint CreateNoWindow = 0x08000000;

    public enum WtsInfoClass
    {
        UserName = 5,
        DomainName = 7,
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WtsSessionInfo
    {
        public int SessionId;
        public IntPtr WinStationName;
        public int State;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfo
    {
        public int Cb;
        public string? Reserved;
        public string? Desktop;
        public string? Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2Size;
        public IntPtr Reserved2;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }

    [DllImport("wtsapi32.dll", EntryPoint = "WTSEnumerateSessionsW", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool WTSEnumerateSessions(
        IntPtr server, int reserved, int version, out IntPtr sessionInfo, out int count);

    [DllImport("wtsapi32.dll")]
    public static extern void WTSFreeMemory(IntPtr memory);

    [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool WTSQuerySessionInformation(
        IntPtr server, int sessionId, WtsInfoClass infoClass, out IntPtr buffer, out int bytes);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    public static extern bool WTSQueryUserToken(int sessionId, out IntPtr token);

    [DllImport("kernel32.dll")]
    public static extern int WTSGetActiveConsoleSessionId();

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool DuplicateTokenEx(
        IntPtr existingToken,
        uint desiredAccess,
        IntPtr tokenAttributes,
        int impersonationLevel,
        int tokenType,
        out IntPtr newToken);

    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);

    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool DestroyEnvironmentBlock(IntPtr environment);

    [DllImport("advapi32.dll", EntryPoint = "CreateProcessAsUserW", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUser(
        IntPtr token,
        string? applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string? currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    // --- Fuer die Meldung selbst ---------------------------------------------------

    public const uint FlashAll = 0x3;
    public const uint FlashUntilForeground = 0xC;

    [StructLayout(LayoutKind.Sequential)]
    public struct FlashInfo
    {
        public int Size;
        public IntPtr Window;
        public uint Flags;
        public uint Count;
        public uint Timeout;
    }

    /// <summary>Laesst die Schaltflaeche in der Taskleiste blinken, bis das Fenster vorn ist.</summary>
    [DllImport("user32.dll")]
    public static extern bool FlashWindowEx(ref FlashInfo info);

    public const int DwmUseImmersiveDarkMode = 20;
    public const int DwmWindowCornerPreference = 33;
    public const int DwmCornerRound = 2;

    /// <summary>Abgerundete Ecken und dunkle Titelleiste ab Windows 11; aeltere uebergehen es.</summary>
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
}
