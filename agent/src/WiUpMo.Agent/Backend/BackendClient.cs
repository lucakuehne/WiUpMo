using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using WiUpMo.Agent.Contracts;
using WiUpMo.Agent.Storage;

namespace WiUpMo.Agent.Backend;

/// <summary>
/// Antwort des Backends, die kein Erfolg war. Der Statuscode bleibt erhalten,
/// weil der Agent auf 401 anders reagiert als auf alles andere.
/// </summary>
public sealed class BackendException(HttpStatusCode statusCode, string message)
    : Exception(message)
{
    public HttpStatusCode StatusCode { get; } = statusCode;
}

public sealed class BackendClient : IDisposable
{
    /// <summary>
    /// Muss zum Vertrag des Backends passen: dort ist die
    /// <c>ValidationPipe</c> auf <c>forbidNonWhitelisted</c> gestellt, ein
    /// unbekanntes Feld laesst also den ganzen Snapshot durchfallen.
    /// </summary>
    private static readonly JsonSerializerOptions Json = AgentJson.Options;

    private readonly HttpClient _http;

    public BackendClient(AgentOptions options)
    {
        if (!Uri.TryCreate(options.BackendUrl, UriKind.Absolute, out Uri? baseUri)
            || (baseUri.Scheme != Uri.UriSchemeHttps && baseUri.Scheme != Uri.UriSchemeHttp))
        {
            throw new ArgumentException(
                $"'{options.BackendUrl}' ist keine gueltige Backend-Adresse.", nameof(options));
        }

        // Ohne abschliessenden Schraegstrich verwirft Uri beim Zusammensetzen
        // das letzte Pfadsegment der Basisadresse.
        if (!baseUri.AbsolutePath.EndsWith('/'))
        {
            baseUri = new Uri(baseUri.ToString() + "/");
        }

        _http = new HttpClient
        {
            BaseAddress = baseUri,
            Timeout = TimeSpan.FromSeconds(options.HttpTimeoutSeconds),
        };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd($"WiUpMo-Agent/{AgentVersion.Current}");
    }

    public async Task<DeviceIdentity> EnrollAsync(EnrollRequest request, CancellationToken ct)
    {
        using HttpResponseMessage response = await _http
            .PostAsJsonAsync("api/agent/v1/enroll", request, Json, ct)
            .ConfigureAwait(false);

        EnrollResponse payload = await ReadAsync<EnrollResponse>(response, ct).ConfigureAwait(false);

        if (string.IsNullOrWhiteSpace(payload.DeviceId) || string.IsNullOrWhiteSpace(payload.DeviceSecret))
        {
            throw new BackendException(
                response.StatusCode, "Die Enrollment-Antwort enthielt keine Geraeteidentitaet.");
        }

        return new DeviceIdentity(payload.DeviceId, payload.DeviceSecret);
    }

    public Task<CheckinResponse> CheckinAsync(
        DeviceIdentity identity,
        Snapshot snapshot,
        CancellationToken ct) =>
        PostAsync<Snapshot, CheckinResponse>("api/agent/v1/checkin", identity, snapshot, ct);

    /// <summary>
    /// Nachreichung aus der Offline-Warteschlange. Auch ein einzelner Snapshot
    /// geht diesen Weg: das Backend verarbeitet jeden in einer eigenen
    /// Transaktion und quittiert ihn einzeln, damit ein fehlerhafter Eintrag
    /// die uebrigen nicht mitreisst.
    /// </summary>
    public Task<CheckinResponse> CheckinBatchAsync(
        DeviceIdentity identity,
        IReadOnlyList<Snapshot> snapshots,
        CancellationToken ct) =>
        PostAsync<BatchCheckinRequest, CheckinResponse>(
            "api/agent/v1/checkin/batch", identity, new BatchCheckinRequest { Snapshots = snapshots }, ct);

    private async Task<TResponse> PostAsync<TRequest, TResponse>(
        string path,
        DeviceIdentity identity,
        TRequest payload,
        CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(payload, options: Json),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", identity.Token);

        using HttpResponseMessage response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        return await ReadAsync<TResponse>(response, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Der Antwortkoerper wird auch im Fehlerfall gelesen — die NestJS-Meldung
    /// zu einer fehlgeschlagenen Validierung nennt das betroffene Feld, und
    /// ohne sie ist ein abgelehnter Snapshot praktisch nicht zu diagnostizieren.
    /// </summary>
    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken ct)
    {
        string body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            throw new BackendException(
                response.StatusCode,
                $"Das Backend antwortete mit {(int)response.StatusCode} {response.ReasonPhrase}: " +
                Limits.Truncate(body, 1024));
        }

        try
        {
            return JsonSerializer.Deserialize<T>(body, Json)
                ?? throw new BackendException(response.StatusCode, "Leere Antwort vom Backend.");
        }
        catch (JsonException ex)
        {
            throw new BackendException(
                response.StatusCode, $"Die Antwort des Backends war nicht lesbar: {ex.Message}");
        }
    }

    public void Dispose() => _http.Dispose();
}
