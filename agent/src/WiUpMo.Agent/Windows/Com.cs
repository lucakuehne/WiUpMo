using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;

namespace WiUpMo.Agent.Windows;

/// <summary>
/// Fehler beim Zugriff auf die Windows-Update-API. Traegt eine Meldung, die
/// ohne Stacktrace verstaendlich ist — der Agent protokolliert sie so.
/// </summary>
public sealed class WindowsUpdateException(string message, Exception? innerException = null)
    : Exception(message, innerException);

/// <summary>
/// Spaete Bindung an die WUApi-COM-Objekte ueber IDispatch.
///
/// Bewusst ueber <see cref="Type.InvokeMember(string, BindingFlags, Binder, object, object[], CultureInfo)"/>
/// statt ueber <c>dynamic</c>: der Aufruf ist damit eindeutig — vor allem bei
/// indizierten Eigenschaften wie <c>Item</c>, wo der C#-Laufzeitbinder je nach
/// Schreibweise etwas anderes tut — und der Agent zieht den Binder samt
/// Microsoft.CSharp nicht in das Single-File-Publish.
///
/// Alle <c>TryXxx</c>-Methoden schlucken Zugriffsfehler und liefern
/// <c>null</c>. Das ist hier richtig: einzelne Update-Eigenschaften sind je
/// nach Herkunft des Updates nicht gesetzt und werfen dann. Ein fehlendes
/// Feld darf nicht die ganze Erfassung scheitern lassen.
/// </summary>
internal static class Com
{
    public static object Create(string progId)
    {
        Type type = Type.GetTypeFromProgID(progId, throwOnError: false)
            ?? throw new WindowsUpdateException(
                $"Die COM-Komponente '{progId}' ist auf diesem System nicht registriert.");

        try
        {
            return Activator.CreateInstance(type)
                ?? throw new WindowsUpdateException($"'{progId}' konnte nicht erzeugt werden.");
        }
        catch (Exception ex) when (ex is COMException or TargetInvocationException or UnauthorizedAccessException)
        {
            throw new WindowsUpdateException(
                $"'{progId}' konnte nicht erzeugt werden: {ex.Message}", ex);
        }
    }

    public static void Release(object? comObject)
    {
        if (comObject is null || !Marshal.IsComObject(comObject))
        {
            return;
        }

        try
        {
            Marshal.FinalReleaseComObject(comObject);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException)
        {
            // Referenz war schon freigegeben. Kein Grund, den Durchlauf
            // deswegen abzubrechen.
        }
    }

    public static object? Get(object target, string name, params object?[] args) =>
        Invoke(target, name, BindingFlags.GetProperty, args);

    public static void Set(object target, string name, object? value) =>
        Invoke(target, name, BindingFlags.SetProperty, [value]);

    public static object? Call(object target, string name, params object?[] args) =>
        Invoke(target, name, BindingFlags.InvokeMethod, args);

    public static object Require(object? value, string what) =>
        value ?? throw new WindowsUpdateException($"{what} lieferte keinen Wert.");

    private static object? Invoke(object target, string name, BindingFlags flags, object?[] args) =>
        target.GetType().InvokeMember(
            name, flags, binder: null, target, args, CultureInfo.InvariantCulture);

    // --- Nachsichtige Varianten ---------------------------------------------

    public static object? TryGet(object target, string name, params object?[] args)
    {
        try
        {
            return Get(target, name, args);
        }
        catch (Exception ex) when (IsAccessFailure(ex))
        {
            return null;
        }
    }

    public static string? TryGetString(object target, string name)
    {
        string? value = TryGet(target, name) as string;
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    public static bool TryGetBool(object target, string name) =>
        TryGet(target, name) is bool value && value;

    public static int? TryGetInt(object target, string name) => ToInt(TryGet(target, name));

    public static decimal? TryGetDecimal(object target, string name)
    {
        try
        {
            return TryGet(target, name) is { } value
                ? Convert.ToDecimal(value, CultureInfo.InvariantCulture)
                : null;
        }
        catch (Exception ex) when (ex is InvalidCastException or FormatException or OverflowException)
        {
            return null;
        }
    }

    public static DateTime? TryGetDateTime(object target, string name) =>
        TryGet(target, name) as DateTime?;

    public static int? ToInt(object? value)
    {
        try
        {
            return value is null ? null : Convert.ToInt32(value, CultureInfo.InvariantCulture);
        }
        catch (Exception ex) when (ex is InvalidCastException or FormatException or OverflowException)
        {
            return null;
        }
    }

    // --- Sammlungen ----------------------------------------------------------

    /// <summary>
    /// Laeuft eine COM-Sammlung ab. Der Zugriff geht ueber die indizierte
    /// Eigenschaft <c>Item</c> statt ueber <c>foreach</c>: nicht jede
    /// WUApi-Sammlung stellt <c>IEnumVARIANT</c> zuverlaessig bereit.
    /// </summary>
    public static IEnumerable<object> Enumerate(object? collection, int maxItems = int.MaxValue)
    {
        if (collection is null)
        {
            yield break;
        }

        int count = TryGetInt(collection, "Count") ?? 0;
        int take = Math.Min(count, maxItems);

        for (int i = 0; i < take; i++)
        {
            if (TryGet(collection, "Item", i) is { } item)
            {
                yield return item;
            }
        }
    }

    /// <summary>Liest eine <c>IStringCollection</c>-Eigenschaft.</summary>
    public static string[] ReadStrings(object owner, string propertyName, int maxItems = int.MaxValue)
    {
        object? collection = TryGet(owner, propertyName);
        return [.. Enumerate(collection, maxItems)
            .OfType<string>()
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s.Trim())];
    }

    /// <summary>
    /// Liest aus jedem Element einer Sammlung eine Zeichenketten-Eigenschaft,
    /// etwa <c>Name</c> aus <c>ICategoryCollection</c>.
    /// </summary>
    public static string[] ReadStrings(
        object owner,
        string propertyName,
        string itemProperty,
        int maxItems = int.MaxValue)
    {
        object? collection = TryGet(owner, propertyName);
        return [.. Enumerate(collection, maxItems)
            .Select(item => TryGetString(item, itemProperty))
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Select(s => s!)];
    }

    private static bool IsAccessFailure(Exception ex) =>
        ex is COMException
            or TargetInvocationException
            or MissingMemberException
            or MissingMethodException
            or InvalidCastException
            or NotSupportedException
            or ArgumentException;
}
