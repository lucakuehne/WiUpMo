using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace WiUpMo.Agent.Restart;

/// <summary>
/// Eine Meldung, die gerade beim Benutzer steht.
///
/// Der Dienst startet dieselbe EXE mit <c>--restart-prompt</c> im Konto des
/// Benutzers, in dessen Sitzung. Verbunden sind beide ueber eine Named Pipe,
/// die nur dieser Benutzer und das System oeffnen duerfen; ihr Name ist
/// zufaellig. Der Dienst schickt, was anzuzeigen ist, die Meldung schickt die
/// Wahl zurueck. Schliesst der Dienst die Pipe, schliesst sich die Meldung —
/// so verschwindet sie, wenn der Auftrag im Backend abgebrochen wird.
///
/// Die Meldung laeuft ohne Adminrechte. Neu gestartet wird ausschliesslich vom
/// Dienst.
/// </summary>
public sealed class PromptSession : IDisposable
{
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromMinutes(2);

    private readonly NamedPipeServerStream _pipe;
    private readonly CancellationTokenSource _cts = new();

    private PromptSession(NamedPipeServerStream pipe, string user, PromptRequest request)
    {
        _pipe = pipe;
        User = user;
        Answer = ConverseAsync(request, _cts.Token);
    }

    /// <summary>Wer die Meldung sieht.</summary>
    public string User { get; }

    /// <summary>Die Wahl des Benutzers; null, wenn die Meldung ohne Antwort endete.</summary>
    public Task<PromptAnswer?> Answer { get; }

    public static PromptSession Start(UserSession session, PromptRequest request)
    {
        string pipeName = $"wiupmo-restart-{Guid.NewGuid():N}";
        string exe = Environment.ProcessPath
            ?? throw new InvalidOperationException("Der Pfad der eigenen EXE ist unbekannt.");

        if (!NativeMethods.WTSQueryUserToken(session.Id, out IntPtr userToken))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), $"Kein Anmeldetoken fuer Sitzung {session.Id}.");
        }

        IntPtr primaryToken = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        NamedPipeServerStream? pipe = null;

        try
        {
            SecurityIdentifier user;
            using (var identity = new WindowsIdentity(userToken))
            {
                user = identity.User ?? throw new InvalidOperationException("Das Konto der Sitzung hat keine SID.");
            }

            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                PipeAccessRights.FullControl,
                AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.ReadWrite, AccessControlType.Allow));

            pipe = NamedPipeServerStreamAcl.Create(
                pipeName,
                PipeDirection.InOut,
                maxNumberOfServerInstances: 1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                inBufferSize: 0,
                outBufferSize: 0,
                security);

            if (!NativeMethods.DuplicateTokenEx(
                    userToken,
                    NativeMethods.MaximumAllowed,
                    IntPtr.Zero,
                    NativeMethods.SecurityImpersonation,
                    NativeMethods.TokenPrimary,
                    out primaryToken))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Das Anmeldetoken liess sich nicht duplizieren.");
            }

            if (!NativeMethods.CreateEnvironmentBlock(out environment, primaryToken, inherit: false))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Die Umgebung des Benutzers liess sich nicht anlegen.");
            }

            var startup = new NativeMethods.StartupInfo
            {
                Cb = Marshal.SizeOf<NativeMethods.StartupInfo>(),
                Desktop = @"winsta0\default",
            };
            var commandLine = new StringBuilder($"\"{exe}\" --restart-prompt --pipe {pipeName}");

            // Ohne Konsolenfenster: Die EXE ist eine Konsolenanwendung, sichtbar
            // sein soll nur die Meldung selbst.
            if (!NativeMethods.CreateProcessAsUser(
                    primaryToken,
                    null,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    inheritHandles: false,
                    NativeMethods.CreateUnicodeEnvironment | NativeMethods.CreateNoWindow,
                    environment,
                    Path.GetDirectoryName(exe),
                    ref startup,
                    out NativeMethods.ProcessInformation process))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Die Meldung liess sich nicht starten.");
            }

            NativeMethods.CloseHandle(process.Thread);
            NativeMethods.CloseHandle(process.Process);

            var result = new PromptSession(pipe, session.User, request);
            pipe = null;
            return result;
        }
        finally
        {
            pipe?.Dispose();
            if (environment != IntPtr.Zero)
            {
                NativeMethods.DestroyEnvironmentBlock(environment);
            }

            if (primaryToken != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(primaryToken);
            }

            NativeMethods.CloseHandle(userToken);
        }
    }

    /// <summary>
    /// Wartet auf die Meldung, schickt ihr, was sie zeigen soll, und dann auf
    /// die Wahl — so lange, wie der Benutzer braucht. Endet die Verbindung ohne
    /// Antwort (abgemeldet, Prozess beendet), ist das Ergebnis null.
    /// </summary>
    private async Task<PromptAnswer?> ConverseAsync(PromptRequest request, CancellationToken ct)
    {
        try
        {
            using (var connect = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                connect.CancelAfter(ConnectTimeout);
                await _pipe.WaitForConnectionAsync(connect.Token).ConfigureAwait(false);
            }

            var writer = new StreamWriter(_pipe, PromptJson.Encoding, leaveOpen: true) { AutoFlush = true };
            await writer.WriteLineAsync(JsonSerializer.Serialize(request, PromptJson.Options).AsMemory(), ct)
                .ConfigureAwait(false);

            using var reader = new StreamReader(_pipe, PromptJson.Encoding, leaveOpen: true);
            string? line = await reader.ReadLineAsync(ct).ConfigureAwait(false);
            return line is null ? null : JsonSerializer.Deserialize<PromptAnswer>(line, PromptJson.Options);
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException or JsonException
                                      or ObjectDisposedException)
        {
            return null;
        }
    }

    /// <summary>Schliesst die Verbindung — und damit die Meldung, falls sie noch steht.</summary>
    public void Dispose()
    {
        _cts.Cancel();
        _pipe.Dispose();
        _cts.Dispose();
    }
}
