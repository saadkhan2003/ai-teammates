using System.Text.RegularExpressions;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class MigrationManifestTests
{
    public static string Root()
    {
        var configured = Environment.GetEnvironmentVariable("TEST_SOURCE_ROOT");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(Path.Combine(configured, "apps/api/Platform.cs"))) return configured;
        foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var dir = new DirectoryInfo(start);
            while (dir != null && !File.Exists(Path.Combine(dir.FullName, "apps/api/Platform.cs"))) dir = dir.Parent;
            if (dir is not null) return dir.FullName;
        }
        throw new InvalidOperationException("Repository root not found");
    }

    [Fact]
    public void Manifest_and_docker_copy_cover_every_file_once_in_ascending_order()
    {
        var root = Root();
        var source = File.ReadAllText(Path.Combine(root, "apps/api/Platform.cs"));
        var manifest = source.Split("MigrationFiles =", 2)[1].Split("];", 2)[0];
        var listed = Regex.Matches(manifest, "\"([0-9]{3}_[^\"]+\\.sql)\"")
            .Select(match => match.Groups[1].Value).ToArray();
        Assert.Equal(Teammates.Api.Platform.MigrationFiles, listed);
        var files = Directory.GetFiles(Path.Combine(root, "db"), "*.sql").Select(Path.GetFileName).Order().ToArray();
        Assert.Equal(files, listed);
        Assert.Equal(listed.Length, listed.Distinct().Count());
        var ids = listed.Select(file => int.Parse(file[..3])).ToArray();
        Assert.Equal(ids.Length, ids.Distinct().Count());
        // v0.5: speed 043–046, briefs 047–049, then usage credits and resources as 050–051. v1 streams reserve 052–056; ids stay strictly ascending.
        Assert.Equal(Enumerable.Range(1, 51), ids.Take(51));
        Assert.Equal(ids.Order(), ids);
        Assert.Equal(ids.Distinct(), ids);
        Assert.Equal(new[] { "047_task_briefs.sql", "048_brief_lessons.sql", "049_approval_signals.sql", "050_usage_credits.sql", "051_resources.sql" }, listed[46..51]);
        Assert.Contains("053_pages.sql", listed);
        Assert.Contains("054_account_support.sql", listed);
        Assert.Equal(63, ids[^1]);
        Assert.DoesNotContain(ids, id => id is >= 90 and <= 99);
        var copies = Regex.Matches(File.ReadAllText(Path.Combine(root, "apps/api/Dockerfile")),
            @"(?m)^COPY db/(\S+\.sql) /migrations/(\S+\.sql)$");
        Assert.All(copies, copy => Assert.Equal(copy.Groups[1].Value, copy.Groups[2].Value));
        Assert.Equal(listed, copies.Select(copy => copy.Groups[1].Value));
    }
}
