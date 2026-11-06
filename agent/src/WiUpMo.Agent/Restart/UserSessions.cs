using System.ComponentModel;
using System.Runtime.InteropServices;

namespace WiUpMo.Agent.Restart;

/// <summary>Eine Sitzung mit angemeldetem Benutzer.</summary>
/// <param name="Active">Am Bildschirm oder per Remotedesktop verbunden — dort laesst sich etwas zeigen.</param>
/// <param name="Console">Die Sitzung am Bildschirm des Geraets.</param>
public sealed record UserSession(int Id, string User, bool Active, bool Console);

/// <summary>
/// Wer gerade angemeldet ist.
///
/// Gezaehlt werden aktive und getrennte Sitzungen: Eine getrennte Sitzung —
/// Benutzer gewechselt, Remotedesktop geschlossen — hat noch offene Programme.
/// Dort laesst sich nichts zeigen, ein sofortiger Neustart nahme dem Benutzer
/// aber ungespeicherte Arbeit. Sitzung 0 gehoert den Diensten und zaehlt nie.
/// </summary>
public static class UserSessions
{
    /// <summary>Aktive zuerst, darunter die am Bildschirm.</summary>
    public static IReadOnlyList<UserSession> List()
    {
        if (!NativeMethods.WTSEnumerateSessions(IntPtr.Zero, 0, 1, out IntPtr buffer, out int count))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Die Sitzungen liessen sich nicht aufzaehlen.");
        }

        int console = NativeMethods.WTSGetActiveConsoleSessionId();
        var sessions = new List<UserSession>();

        try
        {
            int size = Marshal.SizeOf<NativeMethods.WtsSessionInfo>();
            for (int i = 0; i < count; i++)
            {
                var info = Marshal.PtrToStructure<NativeMethods.WtsSessionInfo>(buffer + (i * size));
                if (info.SessionId == 0
                    || info.State is not (NativeMethods.WtsActive or NativeMethods.WtsDisconnected))
                {
                    continue;
                }

                string? user = Query(info.SessionId, NativeMethods.WtsInfoClass.UserName);
                if (string.IsNullOrEmpty(user))
                {
                    continue;
                }

                string? domain = Query(info.SessionId, NativeMethods.WtsInfoClass.DomainName);
                sessions.Add(new UserSession(
                    info.SessionId,
                    string.IsNullOrEmpty(domain) ? user : $@"{domain}\{user}",
                    info.State == NativeMethods.WtsActive,
                    info.SessionId == console));
            }
        }
        finally
        {
            NativeMethods.WTSFreeMemory(buffer);
        }

        return [.. sessions.OrderByDescending(s => s.Active).ThenByDescending(s => s.Console)];
    }

    private static string? Query(int sessionId, NativeMethods.WtsInfoClass infoClass)
    {
        if (!NativeMethods.WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out IntPtr buffer, out _))
        {
            return null;
        }

        try
        {
            return Marshal.PtrToStringUni(buffer);
        }
        finally
        {
            NativeMethods.WTSFreeMemory(buffer);
        }
    }
}
