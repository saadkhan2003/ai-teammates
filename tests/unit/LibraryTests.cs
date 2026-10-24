using Teammates.Api;

namespace Teammates.UnitTests;

public class LibraryTests
{
    [Theory]
    [InlineData("photo.png", "text/plain", "image")]
    [InlineData("organize_documents.gs", "application/octet-stream", "unknown")]
    [InlineData("mystery.bin", "application/pdf", "pdf")]
    [InlineData("notes.txt", "image/png", "text")]
    public void DetectsKindsFromExtensionAndMime(string name, string mime, string expected) => Assert.Equal(expected, LibraryKinds.Detect(name, mime));

    [Fact]
    public void SniffsUploadMimeFromContentRatherThanClientMetadata()
    {
        Assert.Equal("image/png", LibraryKinds.SniffMime([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "photo.bin"));
        Assert.Equal("application/octet-stream", LibraryKinds.SniffMime("function run() {}"u8, "organize_documents.gs"));
    }

    [Theory]
    [InlineData("../../folder/report.pdf", "report.pdf")]
    [InlineData("bad\u0000name.txt", "badname.txt")]
    [InlineData("../..", "file")]
    public void SanitizesDisplayNames(string value, string expected) => Assert.Equal(expected, LibraryKinds.SanitizeName(value));

    [Theory]
    [InlineData(".env", true)]
    [InlineData("report.pem", true)]
    [InlineData("id_rsa", true)]
    [InlineData("/workspace/secrets/value.txt", true)]
    [InlineData("organize_documents.gs", false)]
    public void AppliesSensitiveFilenameDenyList(string name, bool expected) => Assert.Equal(expected, LibraryKinds.IsDeniedName(name));

    [Theory]
    [InlineData("page.html", "code", "text/html")]
    [InlineData("image.png", "image", "image/png")]
    [InlineData("mystery.gs", "unknown", "application/octet-stream")]
    public void ContentMimeComesFromTheServerKindTable(string name, string kind, string mime) =>
        Assert.Equal(mime, LibraryKinds.ContentMime(Path.GetExtension(name).TrimStart('.'), kind));

    [Theory]
    [InlineData("html", false)]
    [InlineData("svg", false)]
    [InlineData("png", true)]
    [InlineData("md", true)]
    public void ActiveAndKnownContentHaveExplicitInlineAllowLists(string ext, bool expected) =>
        Assert.Equal(expected, LibraryKinds.InlineSafe(ext, LibraryKinds.Detect("file." + ext, "")));

    [Fact]
    public void GroupsKarachiItemsAtLocalMidnight()
    {
        var now = new DateTimeOffset(2026, 10, 24, 19, 1, 0, TimeSpan.Zero); // 00:01 next day
        var (today, week) = LibraryTime.Boundaries(now, RoutineTime.Zone("Asia/Karachi"));
        Assert.Equal(new DateTimeOffset(2026, 10, 24, 19, 0, 0, TimeSpan.Zero), today);
        Assert.Equal(new DateTimeOffset(2026, 10, 18, 19, 0, 0, TimeSpan.Zero), week);
    }

    [Fact]
    public void GroupsNewYorkAcrossSpringForwardUsingLocalDates()
    {
        var justAfterMidnight = new DateTimeOffset(2026, 3, 8, 5, 1, 0, TimeSpan.Zero);
        var (midnight, _) = LibraryTime.Boundaries(justAfterMidnight, RoutineTime.Zone("America/New_York"));
        Assert.Equal(new DateTimeOffset(2026, 3, 8, 5, 0, 0, TimeSpan.Zero), midnight);
        var now = new DateTimeOffset(2026, 3, 8, 7, 1, 0, TimeSpan.Zero);
        var (today, week) = LibraryTime.Boundaries(now, RoutineTime.Zone("America/New_York"));
        Assert.Equal(new DateTimeOffset(2026, 3, 8, 5, 0, 0, TimeSpan.Zero), today);
        Assert.Equal(new DateTimeOffset(2026, 3, 2, 5, 0, 0, TimeSpan.Zero), week);
    }

    [Fact]
    public void CursorRoundTripsTimestampAndId()
    {
        var at = new DateTimeOffset(2026, 10, 24, 12, 34, 56, TimeSpan.Zero).AddTicks(1234);
        var id = Guid.NewGuid();
        Assert.True(LibraryTime.TryCursor(LibraryTime.Cursor(at, id), out var decodedAt, out var decodedId));
        Assert.Equal(at, decodedAt);
        Assert.Equal(id, decodedId);
    }

    [Theory]
    [InlineData("all", "TRUE")]
    [InlineData("images", "kind IN ('image','screenshots')")]
    [InlineData("screenshots", "source = 'screenshot'")]
    [InlineData("pages", "kind = 'page'")]
    public void SearchTypeFiltersUseOnlyKnownPredicates(string type, string expected) => Assert.Equal(expected, LibraryFilters.TypePredicate(type));

    [Fact]
    public void SearchTypeFilterRejectsUnknownValues() => Assert.Null(LibraryFilters.TypePredicate("anything"));

    [Fact]
    public void ShareTokensAreRandomAndOnlyTheirHashIsStored()
    {
        var first = LibraryShareTokens.Create();
        var second = LibraryShareTokens.Create();
        var hash = LibraryShareTokens.Hash(first);
        Assert.Equal(64, first.Length);
        Assert.NotEqual(first, second);
        Assert.NotEqual(first, hash);
        Assert.True(LibraryShareTokens.Matches(first, hash));
        Assert.False(LibraryShareTokens.Matches(second, hash));
        Assert.False(LibraryShareTokens.Matches("bad", hash));
    }

    [Fact]
    public void OfficeAndDiffFilesHaveUsefulKinds()
    {
        Assert.Equal("doc", LibraryKinds.Detect("report.docx", "application/octet-stream"));
        Assert.Equal("sheet", LibraryKinds.Detect("budget.xlsx", "application/octet-stream"));
        Assert.Equal("doc", LibraryKinds.Detect("slides.pptx", "application/octet-stream"));
        Assert.Equal("code", LibraryKinds.Detect("change.diff", "text/plain"));
    }

    [Theory]
    [InlineData("bytes=2-5", 2, 5, true, true)]
    [InlineData("bytes=8-", 8, 9, true, true)]
    [InlineData("bytes=-3", 7, 9, true, true)]
    [InlineData("bytes=10-", 0, 9, false, false)]
    [InlineData("bytes=1-2,4-5", 0, 9, false, false)]
    public void SharedContentRangesAreValidated(string header, long start, long end, bool partial, bool valid)
    {
        var range = LibraryContentRange.Resolve(header, 10);
        Assert.Equal((start, end, partial, valid), range);
    }
}
