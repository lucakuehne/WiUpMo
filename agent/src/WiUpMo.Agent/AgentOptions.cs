namespace WiUpMo.Agent;

public sealed class AgentOptions
{
    /// <summary>Basisadresse des Backends, z. B. <c>https://wium.intern:3000</c>.</summary>
    public string BackendUrl { get; set; } = string.Empty;

    /// <summary>
    /// Gemeinsames Geheimnis fuer die einmalige Registrierung. Wird nach
    /// erfolgreichem Enrollment nicht mehr gebraucht.
    /// </summary>
    public string EnrollmentToken { get; set; } = string.Empty;

    /// <summary>
    /// Ablage fuer Identitaet, Zustand und spaeter die Offline-Warteschlange.
    /// Standard ist <c>%ProgramData%\WiUpMo</c>.
    /// </summary>
    public string DataDirectory { get; set; } =
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "WiUpMo");

    /// <summary>
    /// Obergrenze fuer einen einzelnen WUApi-Aufruf. Eine beschaedigte
    /// Update-Datenbank kann eine Suche praktisch unbegrenzt blockieren; der
    /// Agent darf daran nicht haengenbleiben.
    /// </summary>
    public int ComTimeoutSeconds { get; set; } = 300;

    public int HttpTimeoutSeconds { get; set; } = 120;

    /// <summary>
    /// <c>true</c> befragt die konfigurierte Update-Quelle (WSUS, Microsoft
    /// Update). <c>false</c> nutzt nur den lokalen Zwischenspeicher — schnell,
    /// aber moeglicherweise veraltet.
    /// </summary>
    public bool SearchOnline { get; set; } = true;

    /// <summary>
    /// Wie weit die Historie beim allerersten Check-in zurueckgelesen wird.
    /// Danach zaehlt nur noch der Fortschrittsmarker.
    /// </summary>
    public int InitialHistoryDays { get; set; } = 90;
}
