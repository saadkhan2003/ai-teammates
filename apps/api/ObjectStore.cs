using System.Collections.Concurrent;
using Amazon.S3;
using Amazon.S3.Model;

namespace Teammates.Api;

/// <summary>Durable home of users' saved files. S3-compatible: Cloudflare R2 in production, SeaweedFS locally.
/// Swapping providers is config only (S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET).</summary>
public interface IObjectStore
{
    string Name { get; }
    Task PutAsync(string key, Stream body, long length, CancellationToken ct);
    Task<Stream?> GetAsync(string key, CancellationToken ct);
    Task DeleteAsync(string key, CancellationToken ct);
    Task<IReadOnlyList<(string Key, long Size)>> ListAsync(string prefix, CancellationToken ct);
}

public sealed class S3ObjectStore(IAmazonS3 s3, string bucket) : IObjectStore
{
    public string Name => "s3";

    public async Task PutAsync(string key, Stream body, long length, CancellationToken ct)
    {
        var request = new PutObjectRequest { BucketName = bucket, Key = key, InputStream = body, AutoCloseStream = false, UseChunkEncoding = false };
        request.Headers.ContentLength = length;
        await s3.PutObjectAsync(request, ct);
    }

    public async Task<Stream?> GetAsync(string key, CancellationToken ct)
    {
        try
        {
            var response = await s3.GetObjectAsync(bucket, key, ct);
            return response.ResponseStream;
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound) { return null; }
    }

    public Task DeleteAsync(string key, CancellationToken ct) => s3.DeleteObjectAsync(bucket, key, ct);

    public async Task<IReadOnlyList<(string Key, long Size)>> ListAsync(string prefix, CancellationToken ct)
    {
        var items = new List<(string, long)>();
        string? token = null;
        do
        {
            var page = await s3.ListObjectsV2Async(new ListObjectsV2Request { BucketName = bucket, Prefix = prefix, ContinuationToken = token }, ct);
            items.AddRange((page.S3Objects ?? []).Select(o => (o.Key, o.Size)));
            token = page.IsTruncated ? page.NextContinuationToken : null;
        } while (token != null);
        return items;
    }
}

/// <summary>For unit tests.</summary>
public sealed class MemoryObjectStore : IObjectStore
{
    public readonly ConcurrentDictionary<string, byte[]> Objects = new();
    public string Name => "memory";

    public async Task PutAsync(string key, Stream body, long length, CancellationToken ct)
    {
        using var copy = new MemoryStream();
        await body.CopyToAsync(copy, ct);
        Objects[key] = copy.ToArray();
    }

    public Task<Stream?> GetAsync(string key, CancellationToken ct) =>
        Task.FromResult<Stream?>(Objects.TryGetValue(key, out var bytes) ? new MemoryStream(bytes, false) : null);

    public Task DeleteAsync(string key, CancellationToken ct) { Objects.TryRemove(key, out _); return Task.CompletedTask; }

    public Task<IReadOnlyList<(string Key, long Size)>> ListAsync(string prefix, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<(string, long)>>(Objects.Where(o => o.Key.StartsWith(prefix, StringComparison.Ordinal)).Select(o => (o.Key, (long)o.Value.Length)).ToList());
}
