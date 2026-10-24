using System.Text.Json.Nodes;
using Teammates.Api;
var directory = args.Length > 0 ? args[0] : "evals/briefs";
Directory.CreateDirectory(Path.Combine(directory, "rendered"));
foreach (var line in File.ReadLines(Path.Combine(directory, "golden.jsonl")))
{
    var item = JsonNode.Parse(line)!.AsObject();
    File.WriteAllText(Path.Combine(directory, "rendered", BriefValidator.Text(item["id"]) + ".md"), BriefRenderer.Render(item["brief"]!.AsObject()));
}
