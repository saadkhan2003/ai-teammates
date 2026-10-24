using System.Text.RegularExpressions;
using Teammates.Api;

namespace Teammates.UnitTests;

public sealed class MigrationManifestTests
{
    public static string Root()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null && !File.Exists(Path.Combine(dir.FullName, "apps/api/Platform.cs"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("Repository root not found");
    }

    [Fact]
    public void Manifest_and_docker_copy_cover_every_file_once_in_linear_order()
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
        // 043–046 are reserved by the parallel program.
        Assert.Equal(Enumerable.Range(1, 42).Concat(new[] { 47, 48, 49 }), ids);
        Assert.DoesNotContain(ids, id => id is >= 90 and <= 99);
        var copies = Regex.Matches(File.ReadAllText(Path.Combine(root, "apps/api/Dockerfile")),
            @"(?m)^COPY db/(\S+\.sql) /migrations/(\S+\.sql)$");
        Assert.All(copies, copy => Assert.Equal(copy.Groups[1].Value, copy.Groups[2].Value));
        Assert.Equal(listed, copies.Select(copy => copy.Groups[1].Value));
    }
}
