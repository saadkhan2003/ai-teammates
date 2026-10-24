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
        // v0.5: speed 043–046, briefs 047–049, then speed's usage credits and resources as 050–051.
        Assert.Equal(Enumerable.Range(1, 51).Concat(Enumerable.Range(57, 7)), ids);
        Assert.Equal(new[] { "047_task_briefs.sql", "048_brief_lessons.sql", "049_approval_signals.sql", "050_usage_credits.sql", "051_resources.sql" }, listed[46..51]);
        Assert.DoesNotContain(ids, id => id is >= 90 and <= 99);
        var copies = Regex.Matches(File.ReadAllText(Path.Combine(root, "apps/api/Dockerfile")),
            @"(?m)^COPY db/(\S+\.sql) /migrations/(\S+\.sql)$");
        Assert.All(copies, copy => Assert.Equal(copy.Groups[1].Value, copy.Groups[2].Value));
        Assert.Equal(listed, copies.Select(copy => copy.Groups[1].Value));
    }
}
