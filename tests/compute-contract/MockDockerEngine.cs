using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Docker.DotNet;
using Teammates.Compute;

namespace Teammates.Compute.Testing;

// In-memory Docker HTTP protocol mock. Never connects to the host daemon.
public sealed class MockDockerEngine : IAsyncDisposable
{
    public DockerClient Client { get; }
    public ConcurrentDictionary<string, Container> Containers { get; } = new();
    public ConcurrentQueue<string> Removed { get; } = new();
    public sealed class Container(string id, string name, JsonElement request)
    {
        public string Id = id;
        public string Name = name;
        public JsonElement Request = request;
        public bool Running;
        public bool Paused;
        public int Unpauses;
    }
    public MockDockerEngine()
    {
        Client = new DockerClientConfiguration(new Uri("http://mock-docker"), new MockCredentials(new EngineHandler(this))).CreateClient(new Version(1, 44));
    }
    private sealed class MockCredentials(HttpMessageHandler handler) : Credentials
    {
        public override bool IsTlsCredentials() => false;
        public override HttpMessageHandler GetHandler(HttpMessageHandler innerHandler) => handler;
        public override void Dispose() { }
    }
    private sealed class EngineHandler(MockDockerEngine engine) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries).Skip(1).ToArray();
            var method = request.Method;
            object body = new { }; var status = HttpStatusCode.OK;
            if (path.SequenceEqual(new[] { "containers", "json" })) body = engine.Containers.Values.Select(x => new { ID = x.Id,
                Names = new[] { "/" + x.Name }, Labels = x.Request.GetProperty("Labels"), Image = "test", Created = 1,
                State = x.Paused ? "paused" : x.Running ? "running" : "exited" }).ToArray();
            else if (path.SequenceEqual(new[] { "containers", "create" }))
            {
                using var parsed = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
                var id = Guid.NewGuid().ToString("N");
                var name = Uri.UnescapeDataString(request.RequestUri.Query.TrimStart('?').Split('&').Single(x => x.StartsWith("name=")).Split('=', 2)[1]);
                engine.Containers[id] = new(id, name, parsed.RootElement.Clone());
                body = new { Id = id, Warnings = Array.Empty<string>() }; status = HttpStatusCode.Created;
            }
            else if (path[0] == "volumes")
            {
                if (method == HttpMethod.Delete) status = HttpStatusCode.NoContent;
                else if (path[1] == "create")
                {
                    using var parsed = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(ct));
                    body = new { Name = parsed.RootElement.GetProperty("Name").GetString(), Mountpoint = "/mock" }; status = HttpStatusCode.Created;
                }
                else { status = HttpStatusCode.NotFound; body = new { message = "No such volume" }; }
            }
            else if (path[0] == "containers")
            {
                var container = engine.Containers.Values.SingleOrDefault(x => x.Id == path[1] || x.Name == path[1]);
                if (container == null) { status = HttpStatusCode.NotFound; body = new { message = "No such container" }; }
                else if (method == HttpMethod.Delete) { engine.Removed.Enqueue(container.Id); engine.Containers.TryRemove(container.Id, out _); status = HttpStatusCode.NoContent; }
                else if (path[2] == "json") body = new { ID = container.Id, Name = "/" + container.Name,
                    Config = new { Labels = container.Request.GetProperty("Labels") },
                    State = new { Running = container.Running, Paused = container.Paused, Status = container.Paused ? "paused" : container.Running ? "running" : "exited" } };
                else
                {
                    switch (path[2])
                    {
                        case "start": container.Running = true; break;
                        case "pause": container.Paused = true; break;
                        case "unpause": container.Paused = false; container.Unpauses++; break;
                        case "stop": container.Running = false; break;
                        default: throw new InvalidOperationException("Unexpected mock request " + request.RequestUri.AbsolutePath);
                    }
                    status = HttpStatusCode.NoContent;
                }
            }
            else throw new InvalidOperationException("Unexpected mock endpoint " + request.RequestUri.AbsolutePath);
            return new HttpResponseMessage(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };
        }
    }
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    public sealed class DesktopHandler : HttpMessageHandler
    {
        public bool Healthy = true;
        public TaskCompletionSource? Block;
        public TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public List<string> Probes = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (Block != null) { Entered.TrySetResult(); await Block.Task.WaitAsync(cancellationToken); }
            Probes.Add(request.RequestUri!.AbsolutePath);
            var response = request.RequestUri.AbsolutePath == "/desktops"
                ? "{\"ready\":true,\"chrome\":true}"
                : "{\"webSocketDebuggerUrl\":\"ws://computer/devtools/browser/mock\"}";
            return new HttpResponseMessage(Healthy ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable) { Content = new StringContent(response, Encoding.UTF8, "application/json") };
        }
    }
    public sealed class NoSecrets : IExecSecretResolver
    {
        public Task<IReadOnlyDictionary<string, string>> ResolveAsync(ComputerId id, IReadOnlyList<SecretEnvBinding> bindings, CancellationToken ct) => throw new InvalidOperationException("No secrets in lifecycle tests");
    }
    public sealed class NoSnapshots : ISnapshotStore
    {
        public Task SaveAsync(string snapshotId, string name, Stream content, CancellationToken ct) => throw new NotSupportedException();
        public Task<Stream> OpenAsync(string snapshotId, string name, CancellationToken ct) => throw new NotSupportedException();
    }
}
