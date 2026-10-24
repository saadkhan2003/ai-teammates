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
        Assert.Equal(ids.Order(), ids);
        Assert.Equal(54, ids[^1]);
        Assert.DoesNotContain(ids, id => id is >= 90 and <= 99);
        var copies = Regex.Matches(File.ReadAllText(Path.Combine(root, "apps/api/Dockerfile")),
            @"(?m)^COPY db/(\S+\.sql) /migrations/(\S+\.sql)$");
        Assert.All(copies, copy => Assert.Equal(copy.Groups[1].Value, copy.Groups[2].Value));
        Assert.Equal(listed, copies.Select(copy => copy.Groups[1].Value));
    }
}
