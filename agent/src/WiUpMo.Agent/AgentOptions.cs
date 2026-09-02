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
    /// Ablage fuer Identitaet, Warteschlange und Protokolle. Standard ist
    /// <c>%ProgramData%\WiUpMo</c>.
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

    // --- Dienstbetrieb -------------------------------------------------------

    /// <summary>Abstand zwischen zwei regulaeren Durchlaeufen.</summary>
    public double CheckIntervalHours { get; set; } = 4;

    /// <summary>
    /// Wartezeit nach dem Dienststart bis zum ersten Durchlauf. Der Dienst
    /// startet mit dem System; eine Update-Suche waehrend des Anmeldevorgangs
    /// konkurriert mit allem anderen um Platte und Netz.
    /// </summary>
    public int StartupDelaySeconds { get; set; } = 120;

    /// <summary>
    /// Mindestabstand zwischen zwei durch Netzwerkwechsel ausgeloesten
    /// Durchlaeufen. Ohne Entprellung feuert ein einzelner VPN-Aufbau
    /// mehrfach — jede Adressaenderung erzeugt ein eigenes Ereignis.
    /// </summary>
    public int NetworkDebounceMinutes { get; set; } = 5;

    // --- Offline-Warteschlange ----------------------------------------------

    /// <summary>
    /// Obergrenzen der Warteschlange. Ohne sie waechst die Datei bei einem
    /// Laptop, der monatelang nicht ins Firmennetz kommt, unbegrenzt.
    /// </summary>
    public int QueueMaxSnapshots { get; set; } = 200;

    public int QueueMaxAgeDays { get; set; } = 30;

    /// <summary>Aufbewahrung der Protokolldateien in Tagen.</summary>
    public int LogRetentionDays { get; set; } = 14;
}
