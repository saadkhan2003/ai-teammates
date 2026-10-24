using Teammates.Compute;
using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;

namespace Teammates.Api;

public sealed class AiCatalog(Platform platform) : BackgroundService
{
    private static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(20) };
    private static readonly SemaphoreSlim SyncLock = new(1, 1);
    public static List<AiModel> Parse(JsonElement root)
    {
        var result = new List<AiModel>();
        foreach (var model in root.GetProperty("data").EnumerateArray())
        {
            string? Text(JsonElement obj, string key) => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(key, out var value) && value.ValueKind != JsonValueKind.Null ? value.ToString() : null;
            int Number(JsonElement obj, string key) => int.TryParse(Text(obj, key), out var n) ? Math.Max(0, n) : 0;
            List<string>? Strings(JsonElement obj, string key) => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Array ? value.EnumerateArray().Select(v => v.GetString()!).ToList() : null;
            var id = Text(model, "id"); if (string.IsNullOrWhiteSpace(id)) continue;
            model.TryGetProperty("architecture", out var architecture); model.TryGetProperty("top_provider", out var top);
            var parameters = Strings(model, "supported_parameters"); var inputs = Strings(architecture, "input_modalities");
            var pricing = model.TryGetProperty("pricing", out var prices) && prices.ValueKind == JsonValueKind.Object ? prices.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.ToString()) : null;
            var max = Number(top, "max_completion_tokens");
            result.Add(new(id, Text(model, "name") ?? id, inputs?.Contains("image") ?? false, parameters?.Contains("tools") ?? false,
                id.Contains("claude", StringComparison.OrdinalIgnoreCase), Number(model, "context_length"), max > 0 ? max : null, parameters, inputs, Strings(architecture, "output_modalities"), pricing, Text(model, "expiration_date")));
        }
        return result;
    }
    public async Task<object> Sync(HttpClient? http = null, CancellationToken ct = default)
    {
        await SyncLock.WaitAsync(ct);
        try
        {
            var results = new List<object>();
            foreach (var provider in (await platform.AiRegistry.Snapshot(ct)).Providers.Where(p => p.Enabled))
            {
                byte[]? bytes = null;
                var key = "";
                try
                {
                    bytes = await platform.AiRegistry.Key(provider.Id, ct);
                    if (bytes == null && provider.Kind != "mock") { results.Add(new { provider_id = provider.Id, ok = false, error = "key_not_set" }); continue; }
                    key = bytes == null ? "" : Encoding.UTF8.GetString(bytes);
                    if (bytes != null) { CryptographicOperations.ZeroMemory(bytes); bytes = null; }
                    using var request = new HttpRequestMessage(HttpMethod.Get, provider.Kind == "anthropic" ? AiGateway.MessagesUrl(provider.BaseUrl).Replace("/messages", "/models") : provider.BaseUrl.TrimEnd('/') + "/models");
                    if (provider.Kind == "anthropic") { request.Headers.Add("x-api-key", key); request.Headers.Add("anthropic-version", "2023-06-01"); }
                    else if (key.Length > 0) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                    using var response = await (http ?? Http).SendAsync(request, ct);
                    // A provider without a Models API keeps its explicit manual entries.
                    if (response.StatusCode is System.Net.HttpStatusCode.NotFound or System.Net.HttpStatusCode.MethodNotAllowed) { results.Add(new { provider_id = provider.Id, ok = true, manual = true }); continue; }
                    response.EnsureSuccessStatusCode();
                    using var doc = JsonDocument.Parse(OutputRedactor.Redact(await response.Content.ReadAsStringAsync(ct), [key]));
                    var models = Parse(doc.RootElement);
                    await using var conn = await platform.Data.OpenConnectionAsync(ct);
                    await using var tx = await conn.BeginTransactionAsync(ct);
                    await conn.ExecuteAsync("SELECT pg_advisory_xact_lock(840044)", transaction: tx);
                    await conn.ExecuteAsync("UPDATE ai_model_catalog SET present=false WHERE provider_id=@id", new { id = provider.Id }, tx);
                    foreach (var entry in models)
                    {
                        // ID-only APIs rely on manually entered capabilities; never invent tools/vision.
                        var manual = provider.Models.FirstOrDefault(m => m.Id == entry.Id);
                        var metadata = provider.Kind != "openrouter" && entry.SupportedParameters == null && manual != null
                            ? manual with { ContextTokens = entry.ContextTokens > 0 ? entry.ContextTokens : manual.ContextTokens, MaxCompletionTokens = entry.MaxCompletionTokens ?? manual.MaxCompletionTokens, Pricing = entry.Pricing ?? manual.Pricing, ExpirationDate = entry.ExpirationDate ?? manual.ExpirationDate } : entry;
                        await conn.ExecuteAsync("INSERT INTO ai_model_catalog(provider_id,model,metadata) VALUES(@id,@model,CAST(@metadata AS jsonb)) ON CONFLICT(provider_id,model) DO UPDATE SET metadata=excluded.metadata,present=true,synced_at=now()", new { id = provider.Id, model = metadata.Id, metadata = JsonSerializer.Serialize(metadata, AiModelRegistry.Json) }, tx);
                    }
                    await conn.ExecuteAsync("INSERT INTO ai_config_audit(actor,action,detail) VALUES(NULL,'catalog.provider_synced',CAST(@detail AS jsonb))", new { detail = JsonSerializer.Serialize(new { provider_id = provider.Id, count = models.Count }) }, tx);
                    await tx.CommitAsync(ct);
                    platform.AiRegistry.Invalidate();
                    results.Add(new { provider_id = provider.Id, ok = true, count = models.Count });
                }
                catch (Exception ex) when (ex is HttpRequestException or JsonException || ex is OperationCanceledException && !ct.IsCancellationRequested)
                { results.Add(new { provider_id = provider.Id, ok = false, error = "catalog_unavailable" }); }
                finally { if (bytes != null) CryptographicOperations.ZeroMemory(bytes); key = ""; }
            }
            return results;
        }
        finally { SyncLock.Release(); }
    }
    public async Task<object[]> Alerts(CancellationToken ct = default)
    {
        var snapshot = await platform.AiRegistry.Snapshot(ct);
        var active = snapshot.Versions.FirstOrDefault(v => v.IsActive);
        var referenced = snapshot.Versions.Where(v => v.IsActive || v.Version == snapshot.Rollout?.CandidateVersion)
            .SelectMany(v => AiModelRegistry.Targets(v.Config)).ToList();
        if (snapshot.KillSwitch?.SafeModel is { } safe) referenced.Add(safe);
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var catalog = (await conn.QueryAsync("SELECT provider_id,model,metadata::text,present FROM ai_model_catalog")).ToList();
        var result = new List<object>();
        foreach (var target in referenced.Distinct())
        {
            var row = catalog.FirstOrDefault(c => (Guid)c.provider_id == target.Provider && (string)c.model == target.Model);
            var synced = catalog.Any(c => (Guid)c.provider_id == target.Provider);
            var model = row == null ? null : JsonSerializer.Deserialize<AiModel>((string)row.metadata, AiModelRegistry.Json);
            if (synced && (row == null || !(bool)row.present)) result.Add(new { provider_id = target.Provider, model = target.Model, reason = "missing_from_catalog", expiration_date = (string?)null });
            else if (model?.ExpirationDate != null) result.Add(new { provider_id = target.Provider, model = target.Model, reason = "scheduled_expiration", expiration_date = model.ExpirationDate });
        }
        return result.ToArray();
    }
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var now = DateTimeOffset.UtcNow;
            var next = now.Date.AddDays(1).AddHours(2);
            try { await Task.Delay(next - now.UtcDateTime, stoppingToken); await Sync(ct: stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception) { /* No provider response, URL or credential is logged. Try the next night. */ }
        }
    }
}
