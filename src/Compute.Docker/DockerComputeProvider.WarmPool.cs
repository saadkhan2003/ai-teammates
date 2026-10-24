using Docker.DotNet;
using Docker.DotNet.Models;
using Microsoft.Extensions.Logging;

namespace Teammates.Compute;

public sealed partial class DockerComputeProvider
{
    private readonly WarmTemplatePool _warmPool;
    private readonly List<string> _staleTemplates = [];
    public int WarmPoolCount => _warmPool.Count;

    // Runs as a hosted service. Startup reaps previous process/configuration templates,
    // even when WARM_POOL_SIZE is now zero. Never adopts one into the bot inventory.
    public async Task RunWarmPoolAsync(CancellationToken ct)
    {
        while (true)
        {
            string? stale;
            lock (_sync) stale = _staleTemplates.FirstOrDefault();
            if (stale == null) break;
            try
            {
                await DestroyTemplateAsync(stale, ct);
                lock (_sync) _staleTemplates.Remove(stale);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception)
            {
                _logger.LogWarning("Stale warm computer template cleanup unavailable");
                await Task.Delay(TimeSpan.FromSeconds(2), ct);
            }
        }
        await _warmPool.RunAsync(_ => _logger.LogWarning("Warm computer template refill unavailable"), ct);
    }

    private CreateContainerParameters BuildWarmTemplate(string id)
    {
        var labels = Labels(new ComputerId(id), "");
        labels.Remove("teammates.owner_id");
        labels.Remove("teammates.computer_id");
        labels["teammates.warm_pool"] = "template";
        labels["teammates.role"] = "warm-template";
        var spec = new CreateComputerSpec(new ComputerId(id), "local", "", _options.ImageRef, IsolationClass.Docker,
            new ResourceLimits(0, (ulong)_options.MemoryBytes, 0, 256), "", new Dictionary<string, string>());
        var request = BuildCreate(spec, ContainerName(spec.Id), "", "", false, 0, labels);
        // The normal image entrypoint would start a browser/profile and needs a credential.
        // Only initialize the image's writable layers; never boot a desktop in a template.
        request.Entrypoint = ["/bin/sh", "-c", "exec sleep infinity"];
        request.Cmd = [];
        request.Env = [];
        request.Healthcheck = new HealthConfig { Test = ["NONE"] };
        request.HostConfig.Binds = [];
        request.HostConfig.ReadonlyRootfs = true;
        request.HostConfig.CapAdd = [];
        request.HostConfig.AutoRemove = false;
        return request;
    }

    private async Task<string> CreateTemplateAsync(CancellationToken ct)
    {
        await EnsureComputerIsolationAsync(ct);
        var request = BuildWarmTemplate("pool-" + Guid.NewGuid().ToString("N"));
        var created = await _client.Containers.CreateContainerAsync(request, ct);
        try
        {
            if (!await _client.Containers.StartContainerAsync(created.ID, new ContainerStartParameters(), ct))
                throw ComputeException.Unavailable("warm template did not start");
            await _client.Containers.PauseContainerAsync(created.ID, ct);
            return created.ID;
        }
        catch { await DestroyTemplateAsync(created.ID, CancellationToken.None); throw; }
    }

    private async Task DestroyTemplateAsync(string id, CancellationToken ct)
    {
        try
        {
            var inspect = await _client.Containers.InspectContainerAsync(id, ct);
            RequireOwned(inspect.Config.Labels);
            if (!inspect.Config.Labels.TryGetValue("teammates.warm_pool", out var pool) || pool != "template")
                throw ComputeException.PermissionDenied("not a warm template");
            await _client.Containers.RemoveContainerAsync(id, new ContainerRemoveParameters { Force = true, RemoveVolumes = true }, ct);
        }
        catch (DockerApiException ex) when ((int)ex.StatusCode == 404) { }
    }
}
