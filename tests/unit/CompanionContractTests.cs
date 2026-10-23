using System.Text.Json;
using Teammates.Api;

namespace Teammates.UnitTests;

public class CompanionContractTests
{
    [Fact]
    public void EveryFixtureHasSchemaRequiredFieldsAndDeserializesAsServerFrame()
    {
        var root = FindRoot();
        using var schema = JsonDocument.Parse(File.ReadAllText(Path.Combine(root,"contracts/companion/protocol.v1.schema.json")));
        var variants = schema.RootElement.GetProperty("oneOf").EnumerateArray().ToArray();
        foreach (var file in Directory.GetFiles(Path.Combine(root,"contracts/companion/fixtures"),"*.json"))
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(file));
            var type = fixture.RootElement.GetProperty("type").GetString();
            var variant = variants.Single(x => x.GetProperty("properties").GetProperty("type").GetProperty("const").GetString()==type);
            foreach (var required in variant.GetProperty("required").EnumerateArray()) Assert.True(fixture.RootElement.TryGetProperty(required.GetString()!,out _),$"{Path.GetFileName(file)} missing {required}");
            var frame = JsonSerializer.Deserialize<DeviceFrame>(fixture.RootElement.GetRawText(),new JsonSerializerOptions(JsonSerializerDefaults.Web));
            Assert.Equal(type,frame?.Type);
        }
    }
    private static string FindRoot()
    {
        var dir=new DirectoryInfo(AppContext.BaseDirectory);
        while(dir!=null&&!File.Exists(Path.Combine(dir.FullName,"contracts/companion/protocol.v1.schema.json")))dir=dir.Parent;
        return dir?.FullName ?? Directory.GetCurrentDirectory();
    }
}
