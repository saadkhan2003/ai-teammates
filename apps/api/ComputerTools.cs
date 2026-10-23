using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Amazon.S3.Model;
using Dapper;
using Teammates.Compute;

namespace Teammates.Api;

public static class ComputerTools
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(90) };
    private const int MaxArtifactBytes = 50_000_000;

    public static async Task<object> Run(Platform platform, Guid botId, Guid taskId, ComputerId computer, string desktop, string tool, JsonElement args, CancellationToken ct)
    {
        var session = await platform.Compute.GetDesktopSessionAsync(computer, new DesktopAccess(DesktopMode.View, 0, TimeSpan.FromSeconds(2), false), ct);
        var baseUrl = new UriBuilder("http", session.Host, 7700).Uri;
        var route = "/desktops/" + Uri.EscapeDataString(desktop);
        if (tool == "record_stop")
        {
            var stopped = await SendJson(platform, baseUrl, route + "/record/stop", new { botId }, ct);
            if (!stopped.Ok) return stopped.Result;
            using var details = JsonDocument.Parse(stopped.Text);
            var recordedPath = details.RootElement.GetProperty("path").GetString() ?? "";
            var fileRoute = route + "/recordings/raw?workspace_bot_id=" + botId + "&path=" + Uri.EscapeDataString(recordedPath);
            using var request = Request(platform, HttpMethod.Get, new Uri(baseUrl, fileRoute));
            using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if (response.StatusCode == HttpStatusCode.Locked) return new { ok = false, reason = "paused: user is in control" };
            response.EnsureSuccessStatusCode();
            if (response.Content.Headers.ContentLength is long length && length > MaxArtifactBytes)
                throw new ToolHalt("invalid", "recording exceeds 50 MB artifact limit");
            await using var input = await response.Content.ReadAsStreamAsync(ct);
            using var output = new MemoryStream();
            var buffer = new byte[64 * 1024];
            while (true)
            {
                var count = await input.ReadAsync(buffer, ct);
                if (count == 0) break;
                if (output.Length + count > MaxArtifactBytes) throw new ToolHalt("invalid", "recording exceeds 50 MB artifact limit");
                await output.WriteAsync(buffer.AsMemory(0, count), ct);
            }
            var bytes = output.ToArray();
            var fileName = details.RootElement.GetProperty("name").GetString() ?? "screen-recording.webm";
            var mime = fileName.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase) ? "video/mp4" : "video/webm";
            return await SaveBinary(platform, botId, taskId, "evidence-" + Path.GetFileNameWithoutExtension(fileName) + Path.GetExtension(fileName), mime, bytes, ct);
        }

        var body = JsonSerializer.Deserialize<Dictionary<string, object?>>(args.GetRawText()) ?? new();
        if (tool == "computer_click") body["coordinateSpace"] = "model";
        if (tool == "record_start") body["botId"] = botId;
        var path = tool switch
        {
            "computer_screenshot" => route + "/screenshot",
            "computer_click" => route + "/click",
            "computer_type" => route + "/type",
            "computer_key" => route + "/key",
            "computer_scroll" => route + "/scroll",
            "record_start" => route + "/record/start",
            _ => throw new ToolHalt("denied", "unknown computer tool")
        };
        if (tool == "computer_screenshot")
        {
            using var request = Request(platform, HttpMethod.Post, new Uri(baseUrl, path), "{}");
            using var response = await Http.SendAsync(request, ct);
            if (response.StatusCode == HttpStatusCode.Locked) return new { ok = false, reason = "paused: user is in control" };
            response.EnsureSuccessStatusCode();
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (bytes.Length > MaxArtifactBytes) throw new ToolHalt("invalid", "screenshot exceeds 50 MB artifact limit");
            var name = "evidence-" + DateTimeOffset.UtcNow.ToString("yyyyMMddTHHmmssfffZ") + ".png";
            return await SaveBinary(platform, botId, taskId, name, "image/png", bytes, ct);
        }
        var result = await SendJson(platform, baseUrl, path, body, ct);
        return result.Result;
    }

    private static async Task<(bool Ok, string Text, object Result)> SendJson(Platform platform, Uri baseUrl, string path, object body, CancellationToken ct)
    {
        using var request = Request(platform, HttpMethod.Post, new Uri(baseUrl, path), JsonSerializer.Serialize(body));
        using var response = await Http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (response.StatusCode == HttpStatusCode.Locked) return (false, text, new { ok = false, reason = "paused: user is in control" });
        if (!response.IsSuccessStatusCode) throw new ToolHalt("invalid", "computer tool failed");
        using var parsed = JsonDocument.Parse(text);
        return (true, text, parsed.RootElement.Clone());
    }

    private static HttpRequestMessage Request(Platform platform, HttpMethod method, Uri uri, string? json = null)
    {
        var request = new HttpRequestMessage(method, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", platform.ComputerToken);
        if (json != null) request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        return request;
    }

    private static async Task<object> SaveBinary(Platform platform, Guid botId, Guid taskId, string name, string mime, byte[] bytes, CancellationToken ct)
    {
        if (bytes.Length > MaxArtifactBytes) throw new ToolHalt("invalid", "artifact exceeds 50 MB limit");
        var key = $"artifacts/{botId}/{Guid.NewGuid():n}/{Path.GetFileName(name)}";
        using var input = new MemoryStream(bytes);
        await platform.S3.PutObjectAsync(new PutObjectRequest { BucketName = platform.Bucket, Key = key, InputStream = input, ContentType = mime }, ct);
        var sha = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        await using var conn = await platform.Data.OpenConnectionAsync(ct);
        var id = await conn.ExecuteScalarAsync<Guid>(
            "INSERT INTO artifacts (bot_id, task_id, name, mime, size_bytes, sha256, object_key) VALUES (@bot,@task,@name,@mime,@size,@sha,@key) RETURNING id",
            new { bot = botId, task = taskId, name, mime, size = bytes.Length, sha, key });
        return new { id, name, mime, bytes = bytes.Length };
    }
}
