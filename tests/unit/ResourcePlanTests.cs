using System.Formats.Tar;
using System.Text;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class ResourcePlanTests
{
    private const long GiB = StorageRules.GiB;
    private static DiskFile D(string p, long size, long mtime = 1) => new(p, size, mtime);
    private static StoredFile S(string p, long size, long mtime = 1) => new(p, size, mtime, "sha", "files/x/" + p, null);

    [Fact]
    public void Standard_plan_defaults_match_the_approved_resource_plan()
    {
        var plan = BillingPlan.Standard;
        Assert.Equal(50, plan.StorageQuotaGb);
        Assert.Equal(80, plan.StorageWarnPct);
        Assert.Equal(8192, plan.RamMb);
        Assert.Equal(1m, plan.CpuMinCores);
        Assert.Equal(2m, plan.CpuMaxCores);
        Assert.Equal(8UL * 1024 * 1024 * 1024, PlanLimits.MemoryBytes(plan));
        Assert.Equal(2000u, PlanLimits.CpuMillis(plan));
        Assert.Equal(2_000_000_000L, PlanLimits.NanoCpus(plan));
    }

    [Fact]
    public void Storage_warns_at_80_percent_and_blocks_writes_at_100()
    {
        var plan = BillingPlan.Standard;
        Assert.Equal(StorageRules.Ok, StorageRules.Status(10 * GiB, 0, plan).State);
        var warn = StorageRules.Status(35 * GiB, 5 * GiB, plan);
        Assert.Equal(StorageRules.Warning, warn.State);
        Assert.Equal(80, warn.Percent);
        Assert.Contains("80%", StorageRules.WarningMessage(warn));
        var full = StorageRules.Status(50 * GiB, 1, plan);
        Assert.Equal(StorageRules.Full, full.State);
        Assert.Equal(100, full.Percent);
        var message = StorageRules.FullMessage(full);
        Assert.Contains("storage is full", message);
        Assert.Contains("delete files", message);
        Assert.True(StorageRules.Writes("write_file"));
        Assert.True(StorageRules.Writes("save_artifact"));
        Assert.False(StorageRules.Writes("shell"));      // shell stays open so the user can delete files
        Assert.False(StorageRules.Writes("read_file"));
    }

    [Fact]
    public void Admin_storage_quota_change_moves_the_threshold()
    {
        var bigger = BillingPlan.Standard with { StorageQuotaGb = 200, StorageWarnPct = 90 };
        Assert.Equal(StorageRules.Ok, StorageRules.Status(160 * GiB, 0, bigger).State);
        Assert.Equal(StorageRules.Warning, StorageRules.Status(181 * GiB, 0, bigger).State);
    }

    [Fact]
    public void Push_uploads_changed_files_and_deletes_only_in_lineage()
    {
        var disk = new[] { D("a.txt", 10, 2), D("b.txt", 5) };
        var stored = new[] { S("a.txt", 10, 1), S("b.txt", 5), S("gone.txt", 7) };
        var inLineage = SyncPlan.Push(disk, stored, lineage: true, usedBytes: 22, quotaBytes: 1000);
        Assert.Equal(["a.txt"], inLineage.Upload.Select(f => f.Path));
        Assert.Equal(["gone.txt"], inLineage.Delete.Select(f => f.Path));
        var fresh = SyncPlan.Push(disk, stored, lineage: false, usedBytes: 22, quotaBytes: 1000);
        Assert.Empty(fresh.Delete); // a restored or fresh disk never wipes stored files
    }

    [Fact]
    public void Push_skips_growth_over_quota_but_still_saves_shrinks()
    {
        var disk = new[] { D("big.bin", 900), D("small.txt", 50), D("shrunk.log", 10, 2) };
        var stored = new[] { S("shrunk.log", 400) };
        var plan = SyncPlan.Push(disk, stored, lineage: true, usedBytes: 400, quotaBytes: 500);
        Assert.Contains(plan.Upload, f => f.Path == "shrunk.log");
        Assert.Contains(plan.Upload, f => f.Path == "small.txt");
        Assert.Equal(["big.bin"], plan.SkippedQuota.Select(f => f.Path));
        var huge = SyncPlan.Push([D("video.mp4", SyncPlan.MaxFileBytes + 1)], [], true, 0, long.MaxValue);
        Assert.Equal(["video.mp4"], huge.TooLarge.Select(f => f.Path));
    }

    [Fact]
    public void Pull_restores_missing_or_newer_files_and_nothing_in_lineage()
    {
        var disk = new[] { D("same.txt", 3, 5), D("old.txt", 3, 1), D("local-newer.txt", 3, 9) };
        var stored = new[] { S("same.txt", 3, 5), S("old.txt", 4, 2), S("local-newer.txt", 2, 3), S("missing.txt", 1) };
        Assert.Equal(["missing.txt", "old.txt"], SyncPlan.Pull(disk, stored, lineage: false).Select(f => f.Path));
        Assert.Empty(SyncPlan.Pull(disk, stored, lineage: true));
    }

    [Theory]
    [InlineData("notes/a.txt", true)]
    [InlineData("../etc/passwd", false)]
    [InlineData("/etc/passwd", false)]
    [InlineData("a//b", false)]
    [InlineData("a/./b", false)]
    [InlineData("", false)]
    public void Sync_paths_must_stay_inside_the_bot_dir(string path, bool ok) => Assert.Equal(ok, SyncPlan.SafePath(path));

    [Fact]
    public void Object_keys_are_content_addressed_per_owner_and_bot()
    {
        var owner = Guid.NewGuid(); var bot = Guid.NewGuid();
        Assert.Equal($"files/{owner:N}/{bot:N}/abc", SyncPlan.ObjectKey(owner, bot, "abc"));
    }

    [Fact]
    public async Task Memory_object_store_round_trips_and_lists_by_prefix()
    {
        IObjectStore store = new MemoryObjectStore();
        await store.PutAsync("files/u/b/1", new MemoryStream(Encoding.UTF8.GetBytes("hello")), 5, default);
        await store.PutAsync("files/u/c/2", new MemoryStream([1, 2]), 2, default);
        await using (var body = await store.GetAsync("files/u/b/1", default))
            Assert.Equal("hello", new StreamReader(body!).ReadToEnd());
        Assert.Equal(["files/u/b/1"], (await store.ListAsync("files/u/b/", default)).Select(o => o.Key));
        await store.DeleteAsync("files/u/b/1", default);
        Assert.Null(await store.GetAsync("files/u/b/1", default));
    }

    [Fact]
    public void Cleanup_keeps_only_the_newest_backups_per_computer()
    {
        var t = new DateTimeOffset(2026, 10, 1, 0, 0, 0, TimeSpan.Zero);
        var backups = Enumerable.Range(0, 5).Select(i => new BackupInfo("a" + i, "c1", t.AddDays(i)))
            .Concat([new BackupInfo("b0", "c2", t), new BackupInfo("b1", "c2", t.AddDays(1))]).ToList();
        var delete = CleanupRules.BackupsToDelete(backups, keep: 3);
        Assert.Equal(["a0", "a1"], delete.OrderBy(x => x));
        Assert.Empty(CleanupRules.BackupsToDelete(backups.Where(b => b.Computer == "c2"), 3));
        Assert.Equal(4, CleanupRules.BackupsToDelete(backups.Where(b => b.Computer == "c1"), 0).Count); // keep is at least one
    }

    [Fact]
    public void Nightly_cleanup_runs_once_at_the_configured_hour()
    {
        var at = new DateTimeOffset(2026, 10, 24, 21, 5, 0, TimeSpan.Zero);
        Assert.True(CleanupRules.Due(at, null, 21));
        Assert.False(CleanupRules.Due(at, at.AddMinutes(-3), 21));
        Assert.True(CleanupRules.Due(at, at.AddDays(-1), 21));
        Assert.False(CleanupRules.Due(at.AddHours(1), null, 21));
    }

    [Fact]
    public void Cleanup_script_targets_only_temp_caches_and_old_downloads()
    {
        var script = CleanupRules.Script(30);
        Assert.Contains("find -P", script);
        Assert.Contains("-xdev", script);
        Assert.Contains("/tmp -mindepth 1 -mmin +1440", script);
        Assert.Contains("Downloads\" -mindepth 1 -mtime +30", script);
        Assert.DoesNotContain("jobs/", script);         // background job logs and results are kept
        Assert.DoesNotContain("rm -rf", script);
    }

    [Fact]
    public void Every_computer_uses_the_one_shared_base_image()
    {
        var root = MigrationManifestTests.Root();
        var routes = File.ReadAllText(Path.Combine(root, "apps/api/Routes.cs"));
        Assert.Contains("platform.Compute.BaseImage", routes);
        foreach (var file in Directory.EnumerateFiles(Path.Combine(root, "apps/api"), "*.cs").Concat(Directory.EnumerateFiles(Path.Combine(root, "src"), "*.cs", SearchOption.AllDirectories)))
        {
            var text = File.ReadAllText(file);
            Assert.DoesNotContain("CommitContainerChangesAsync", text); // no per-user image copies
            Assert.DoesNotContain("COMPUTE_IMAGE", Path.GetFileName(file) == "Program.cs" ? "" : text);
        }
    }

    [Fact]
    public void Workspace_sync_helper_is_embedded_and_runs_without_following_symlinks()
    {
        using var stream = typeof(WorkspaceSync).Assembly.GetManifestResourceStream("workspace_sync.py");
        Assert.NotNull(stream);
        var script = new StreamReader(stream!).ReadToEnd();
        Assert.Contains("O_NOFOLLOW", script);
        Assert.Contains("O_EXCL", script);
    }

    [Fact]
    public async Task Packed_archive_nested_in_the_container_tar_reads_back_through_a_forward_only_stream()
    {
        var inner = new MemoryStream();
        await using (var w = new TarWriter(inner, TarEntryFormat.Pax, leaveOpen: true))
            foreach (var (name, body) in new[] { ("notes/a.txt", "first\n"), ("b.bin", new string('x', 70_000)) })
                await w.WriteEntryAsync(new PaxTarEntry(TarEntryType.RegularFile, name, new Dictionary<string, string> { ["mtime_ns"] = "1700000000123456789" }) { DataStream = new MemoryStream(Encoding.UTF8.GetBytes(body)) });
        inner.Position = 0;
        var outer = new MemoryStream();
        await using (var w = new TarWriter(outer, TarEntryFormat.Pax, leaveOpen: true))
            await w.WriteEntryAsync(new PaxTarEntry(TarEntryType.RegularFile, ".sync-out-1.tar") { DataStream = inner });
        outer.Position = 0;

        await using var packed = await SyncPlan.OpenPackedAsync(new ForwardOnly(outer), CancellationToken.None);
        using var reader = new TarReader(packed);
        var seen = new List<(string, int, string)>();
        while (await reader.GetNextEntryAsync(false) is { } entry)
        {
            using var copy = new MemoryStream();
            await entry.DataStream!.CopyToAsync(copy);
            seen.Add((entry.Name, (int)copy.Length, ((PaxTarEntry)entry).ExtendedAttributes["mtime_ns"]));
        }
        Assert.Equal([("notes/a.txt", 6, "1700000000123456789"), ("b.bin", 70_000, "1700000000123456789")], seen);
        await Assert.ThrowsAsync<InvalidOperationException>(() => SyncPlan.OpenPackedAsync(new MemoryStream(new byte[1024]), CancellationToken.None));
    }

    [Fact]
    public async Task Tar_packed_by_the_real_helper_reads_back()
    {
        var root = Directory.CreateTempSubdirectory("tm-bot-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(root, "notes"));
            await File.WriteAllTextAsync(Path.Combine(root, "notes", "storage-demo.txt"), "first\n");
            await File.WriteAllTextAsync(Path.Combine(root, ".sync-want-1.json"), "[\"notes/storage-demo.txt\"]");
            var script = Path.Combine(Path.GetTempPath(), "tm-sync-" + Guid.NewGuid().ToString("n") + ".py");
            using (var src = typeof(SyncPlan).Assembly.GetManifestResourceStream("workspace_sync.py")!)
            await using (var dst = File.Create(script)) await src.CopyToAsync(dst);
            var psi = new System.Diagnostics.ProcessStartInfo("python3", [script, "pack", ".sync-want-1.json"]) { RedirectStandardOutput = true, RedirectStandardError = true };
            psi.Environment["BOT_ROOT"] = root;
            using var proc = System.Diagnostics.Process.Start(psi)!;
            var stdout = await proc.StandardOutput.ReadToEndAsync();
            await proc.WaitForExitAsync();
            File.Delete(script);
            Assert.True(proc.ExitCode == 0, await proc.StandardError.ReadToEndAsync());
            var tarPath = System.Text.Json.JsonDocument.Parse(stdout.Trim()).RootElement.GetProperty("tar").GetString()!;
            var outer = new MemoryStream();
            await using (var w = new TarWriter(outer, TarEntryFormat.Ustar, leaveOpen: true))
                await w.WriteEntryAsync(tarPath, Path.GetFileName(tarPath));
            outer.Position = 0;
            await using var packed = await SyncPlan.OpenPackedAsync(new ForwardOnly(outer), CancellationToken.None);
            using var reader = new TarReader(packed);
            var entry = await reader.GetNextEntryAsync(false);
            Assert.NotNull(entry);
            Assert.Equal("notes/storage-demo.txt", entry!.Name);
            using var copy = new MemoryStream();
            await entry.DataStream!.CopyToAsync(copy);
            Assert.Equal("first\n", Encoding.UTF8.GetString(copy.ToArray()));
            Assert.True(((PaxTarEntry)entry).ExtendedAttributes.ContainsKey("mtime_ns"));
            Assert.Null(await reader.GetNextEntryAsync(false));
        }
        finally { Directory.Delete(root, true); }
    }

    private sealed class ForwardOnly(Stream inner) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, Math.Min(count, 1000));
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
