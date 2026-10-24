using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Teammates.Compute;

namespace Teammates.Api;

public sealed record BriefIssue(string Field, string Message);
public sealed record BriefQualityResult(double Score, bool Passed, IReadOnlyList<BriefIssue> Issues,
    IReadOnlyList<string> Warnings, IReadOnlyDictionary<string, double> Dimensions, string? SplitSuggestion = null);

public static class BriefValidator
{
    public const string DefaultGate = "Do not push or merge until every acceptance check passes.";
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public static string Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var s) ? s.Trim() : "";
    public static JsonArray Array(JsonNode? node) => node as JsonArray ?? [];
    public static string Clean(string? text) => InjectionFilter.Strip(Dlp.Redact(OutputRedactor.Redact(text ?? "")));
    public static JsonObject Normalize(JsonElement args)
    {
        var result = args.TryGetProperty("brief", out var b) && b.ValueKind == JsonValueKind.Object
            ? JsonNode.Parse(b.GetRawText())!.AsObject() : new JsonObject();
        if (Text(result["goal"]).Length == 0 && args.TryGetProperty("instruction", out var legacy) && legacy.ValueKind == JsonValueKind.String)
            result["goal"] = legacy.GetString();
        if (Text(result["kind"]).Length == 0) result["kind"] = "feature";
        if (Text(result["gate"]).Length == 0) result["gate"] = DefaultGate;
        result["brief_version"] = 1;
        // Scrub each string before serializing; regexes must never operate on JSON syntax.
        return Scrub(result).AsObject();
    }
    private static JsonNode Scrub(JsonNode node)
    {
        if (node is JsonObject o) return new JsonObject(o.Select(p => new KeyValuePair<string, JsonNode?>(p.Key, p.Value is null ? null : Scrub(p.Value))));
        if (node is JsonArray a) return new JsonArray(a.Select(n => n is null ? null : Scrub(n)).ToArray());
        return node is JsonValue v && v.TryGetValue<string>(out var s) ? JsonValue.Create(Clean(s))! : node.DeepClone();
    }
    public static bool Vague(string check)
    {
        if (string.IsNullOrWhiteSpace(check)) return true;
        var text = check.Trim();
        if (Regex.IsMatch(text, @"^(?:works(?: fine)?|looks? good|make sure (?:it |everything )?works|verify (?:it |everything )?works|test(?: it)?|check(?: it)?|manual(?:ly)?|ensure (?:it |everything )?works)[.!\s]*$", RegexOptions.IgnoreCase)) return true;
        return Regex.IsMatch(text, @"^(?:make sure|ensure|verify)\b.*\b(?:works|looks good)\b", RegexOptions.IgnoreCase)
            && !Regex.IsMatch(text, @"test|pytest|dotnet|npm|node|command|snapshot|screenshot|crop|compare|source|curl|sql|playwright", RegexOptions.IgnoreCase);
    }
    public static IReadOnlyList<BriefIssue> Validate(JsonObject b, bool light = false)
    {
        var issues = new List<BriefIssue>();
        void Require(string name, string hint) { if (Text(b[name]).Length == 0) issues.Add(new(name, hint)); }
        Require("goal", "Write one or two sentences describing the desired outcome.");
        Require("report_back", "Specify what to return: evidence paths, test counts, screenshots, and commit SHA when relevant.");
        if (!light)
        {
            // Context may be prose, or a structured quote/mood/background object.
            if (Context(b["context"]).Length == 0) issues.Add(new("context", "Quote the user's words and include their mood, why, and relevant background."));
            if (Array(b["acceptance"]).Count == 0) issues.Add(new("acceptance", "Add at least one {criterion, check}; name a test command, snapshot, or comparison method."));
            for (var i = 0; i < Array(b["acceptance"]).Count; i++)
            {
                var item = Array(b["acceptance"])[i] as JsonObject;
                if (Text(item?["criterion"]).Length == 0) issues.Add(new($"acceptance[{i}].criterion", "Describe an observable success criterion; Given/When/Then is encouraged."));
                if (Vague(Text(item?["check"]))) issues.Add(new($"acceptance[{i}].check", "Replace vague checks with a named test/command, Playwright snapshot, screenshot, or side-by-side crop."));
            }
            if (Text(b["kind"]) == "bugfix")
            {
                var repro = b["repro"] as JsonObject;
                foreach (var field in new[] { "steps", "current", "expected", "unchanged" })
                    if (Text(repro?[field]).Length == 0 && !(field == "steps" && repro?[field] is JsonArray arr && arr.Count > 0 && arr.All(step => Text(step).Length > 0)))
                        issues.Add(new("repro." + field, "Supply bug reproduction " + field + "; identify behavior that must stay unchanged."));
            }
        }
        if (!new[] { "feature", "bugfix", "ui", "refactor", "research", "ops" }.Contains(Text(b["kind"]))) issues.Add(new("kind", "Choose feature, bugfix, ui, refactor, research, or ops."));
        foreach (var (field, allowed) in new[] { ("priority", new[] { "low", "normal", "high", "urgent" }), ("effort", new[] { "small", "medium", "large" }) })
            if (Text(b[field]).Length > 0 && !allowed.Contains(Text(b[field]))) issues.Add(new(field, "Choose " + string.Join(", ", allowed) + "."));
        foreach (var field in new[] { "goal", "kind", "priority", "effort", "budget", "gate", "report_back" })
            if (b[field] is not null && b[field] is not JsonValue || b[field] is JsonValue scalar && !scalar.TryGetValue<string>(out _))
                issues.Add(new(field, "Provide text for this field."));
        foreach (var field in new[] { "references", "non_goals", "rules", "checklist", "acceptance", "assumptions", "open_questions" })
            if (b[field] is not null and not JsonArray) issues.Add(new(field, "Provide an array of items."));
        for (var i = 0; i < Array(b["references"]).Count; i++)
        {
            var r = Array(b["references"])[i] as JsonObject;
            if (r is null || !new[] { "file", "screenshot", "note", "url", "library" }.Contains(Text(r["kind"])) || Text(r["path_or_url"]).Length == 0 || Text(r["why"]).Length == 0)
                issues.Add(new($"references[{i}]", "Provide {kind: file|screenshot|note|url|library, path_or_url, why}."));
        }
        for (var i = 0; i < Array(b["open_questions"]).Count; i++)
        {
            var q = Array(b["open_questions"])[i] as JsonObject;
            if (q is null || Text(q["question"]).Length == 0 || q["blocking"] is not JsonValue v || !v.TryGetValue<bool>(out _))
                issues.Add(new($"open_questions[{i}]", "Provide {question, blocking: true|false}; ask_user first when blocking."));
        }
        foreach (var field in new[] { "rules", "checklist", "non_goals", "assumptions" })
            if (Array(b[field]).Any(n => Text(n).Length == 0)) issues.Add(new(field, "Use non-empty text items."));
        if (b["scope"] is JsonObject scope)
            foreach (var field in new[] { "in", "out" })
                if (scope[field] is not null and not JsonArray || Array(scope[field]).Any(n => Text(n).Length == 0))
                    issues.Add(new("scope." + field, "Provide an array of non-empty paths or boundaries."));
        if (b["scope"] is not null and not JsonObject) issues.Add(new("scope", "Provide an object with in[] and out[] paths."));
        if (b.ToJsonString().Length > 32000) issues.Add(new("brief", "Shorten this brief to at most 32000 characters; reference large documents by path."));
        return issues;
    }
    public static bool Blocking(JsonObject b) => Array(b["open_questions"]).OfType<JsonObject>().Any(q => q["blocking"] is JsonValue v && v.TryGetValue<bool>(out var blocking) && blocking);
    public static string Context(JsonNode? c) => c is JsonObject o ? string.Join("\n", o.Select(p => Text(p.Value)).Where(s => s.Length > 0)) : Text(c);
}

public static class BriefRenderer
{
    public static string Render(JsonObject b, string? autoContext = null)
    {
        var sb = new StringBuilder();
        var priority = BriefValidator.Text(b["priority"]);
        var effort = BriefValidator.Text(b["effort"]);
        var meta = new List<string>();
        if (priority.Length > 0) meta.Add(char.ToUpperInvariant(priority[0]) + priority[1..] + " priority");
        if (effort.Length > 0) meta.Add(effort + " effort");
        if (BriefValidator.Text(b["budget"]) is { Length: > 0 } budget) meta.Add("budget: " + budget);
        if (b["context"] is JsonObject context)
        {
            var author = BriefValidator.Text(context["author"]); var mood = BriefValidator.Text(context["mood"]);
            if (author.Length > 0) meta.Add("from " + author + (mood.Length > 0 ? " (" + mood + ")" : ""));
        }
        if (meta.Count > 0) sb.AppendLine(string.Join(", ", meta) + ": " + BriefValidator.Text(b["goal"])).AppendLine();
        void Section(string heading, string value) { if (!string.IsNullOrWhiteSpace(value)) sb.Append("## ").AppendLine(heading).AppendLine().AppendLine(value.Trim()).AppendLine(); }
        string Lines(JsonNode? n) => string.Join("\n", BriefValidator.Array(n).Select(x => BriefValidator.Text(x)).Where(x => x.Length > 0).Select(x => "- " + x));
        Section("Goal", BriefValidator.Text(b["goal"]));
        Section("Context", BriefValidator.Context(b["context"]));
        Section("References", string.Join("\n", BriefValidator.Array(b["references"]).OfType<JsonObject>().Select(r => $"- [{BriefValidator.Text(r["kind"])}] `{BriefValidator.Text(r["path_or_url"])}` — {BriefValidator.Text(r["why"])}")));
        var scope = b["scope"] as JsonObject;
        Section("Scope", string.Join("\n", new[] { Lines(scope?["in"]) is { Length: > 0 } ins ? "In:\n" + ins : "", Lines(scope?["out"]) is { Length: > 0 } outs ? "Out:\n" + outs : "", Lines(b["non_goals"]) is { Length: > 0 } ng ? "Non-goals:\n" + ng : "" }.Where(x => x.Length > 0)));
        Section("Rules", Lines(b["rules"]));
        Section("Checklist", Lines(b["checklist"]));
        Section("Acceptance criteria", string.Join("\n", BriefValidator.Array(b["acceptance"]).OfType<JsonObject>().Select((a, i) => $"{i + 1}. {BriefValidator.Text(a["criterion"])}")));
        var verification = string.Join("\n", BriefValidator.Array(b["acceptance"]).OfType<JsonObject>().Select((a, i) => $"{i + 1}. {BriefValidator.Text(a["check"])}"));
        if (b["repro"] is JsonObject repro) verification += "\n\nReproduction:\n" + string.Join("\n", repro.Select(p => $"- {p.Key}: {(p.Value is JsonArray ? string.Join("; ", BriefValidator.Array(p.Value).Select(BriefValidator.Text)) : BriefValidator.Text(p.Value))}"));
        Section("Verification", verification);
        Section("Assumptions", Lines(b["assumptions"]));
        Section("Open questions", string.Join("\n", BriefValidator.Array(b["open_questions"]).OfType<JsonObject>().Select(q => "- " + BriefValidator.Text(q["question"]))));
        Section("Gate", BriefValidator.Text(b["gate"]) is { Length: > 0 } gate ? gate : BriefValidator.DefaultGate);
        Section("Report back", BriefValidator.Text(b["report_back"]));
        Section("Auto-attached context", autoContext ?? "");
        return BriefValidator.Clean(sb.ToString().TrimEnd()) + "\n";
    }
}

public static class BriefQuality
{
    public const double Threshold = .7;
    public static BriefQualityResult Score(JsonObject b)
    {
        var scope = b["scope"] as JsonObject;
        var acceptance = BriefValidator.Array(b["acceptance"]).OfType<JsonObject>().ToArray();
        var areas = BriefValidator.Array(scope?["in"]).Select(BriefValidator.Text).Select(p => string.Join('/', p.Split('/', StringSplitOptions.RemoveEmptyEntries).Take(2))).Distinct().Count();
        var split = acceptance.Length > 8 || areas > 3;
        double Has(bool yes) => yes ? 1 : 0;
        var goal = BriefValidator.Text(b["goal"]);
        var context = BriefValidator.Context(b["context"]);
        var rules = BriefValidator.Array(b["rules"]).Select(BriefValidator.Text).ToArray();
        var concreteRules = rules.Count(rule => Regex.IsMatch(rule, @"\d|#[a-fA-F0-9]{3,8}\b|/|`|\b[A-Z][A-Z_]{2,}\b"));
        var d = new Dictionary<string, double>
        {
            ["goalClarity"] = Regex.IsMatch(goal, @"^(?:improve it|fix it|make it better|do the task)[.!\s]*$", RegexOptions.IgnoreCase) ? .2 : Math.Min(1, goal.Length / 45d),
            ["contextWhy"] = Math.Min(1, context.Length / 70d) * (Regex.IsMatch(context, "why|because|need|want|block|frustrat|matter|asked|said|user|quote", RegexOptions.IgnoreCase) ? 1 : .6),
            ["references"] = Has(BriefValidator.Array(b["references"]).OfType<JsonObject>().Any(r => BriefValidator.Text(r["path_or_url"]).Length > 0 && BriefValidator.Text(r["why"]).Length > 0)),
            ["scopeNonGoals"] = Has(BriefValidator.Array(scope?["in"]).Count > 0 && (BriefValidator.Array(scope?["out"]).Count > 0 || BriefValidator.Array(b["non_goals"]).Count > 0)),
            ["rulesSpecificity"] = rules.Length == 0 ? 0 : .4 + .6 * concreteRules / rules.Length,
            ["acceptanceCheckability"] = acceptance.Length == 0 ? 0 : acceptance.Count(a => BriefValidator.Text(a["criterion"]).Length > 10 && !BriefValidator.Vague(BriefValidator.Text(a["check"]))) / (double)acceptance.Length,
            ["verification"] = Has(acceptance.Any(a => Regex.IsMatch(BriefValidator.Text(a["check"]), @"test|pytest|dotnet|npm|node|command|snapshot|screenshot|crop|compare|report|source|curl|sql|inspect|playwright", RegexOptions.IgnoreCase))),
            ["gate"] = Has(BriefValidator.Text(b["gate"]).Length > 15),
            ["reportBack"] = Math.Min(1, BriefValidator.Text(b["report_back"]).Length / 40d) * (Regex.IsMatch(BriefValidator.Text(b["report_back"]), "path|evidence|count|sha|source|screenshot|report", RegexOptions.IgnoreCase) ? 1 : .5),
            ["decomposition"] = split ? .2 : 1
        };
        var issues = d.Where(x => x.Value < .7).Select(x => new BriefIssue(x.Key, Hints[x.Key])).ToArray();
        var score = Math.Round(d.Values.Average(), 3);
        var suggestion = split ? "Split this into independently verifiable briefs: more than eight acceptance items or more than three distinct areas." : null;
        return new(score, score >= Threshold, issues, suggestion is null ? [] : [suggestion], d, suggestion);
    }
    private static readonly Dictionary<string, string> Hints = new()
    {
        ["goalClarity"] = "State a concrete outcome in one or two sentences.", ["contextWhy"] = "Quote the user's words and explain mood and why this matters.",
        ["references"] = "Name exact files, notes, URLs, or screenshots and explain why to read them.", ["scopeNonGoals"] = "List in-scope paths and explicit exclusions or non-goals.",
        ["rulesSpecificity"] = "Preserve exact values, names, and limits as rules.", ["acceptanceCheckability"] = "Give each observable criterion a concrete verification method.",
        ["verification"] = "Name the command, test, snapshot, screenshot comparison, or source audit.", ["gate"] = "Require green acceptance checks before push or merge.",
        ["reportBack"] = "Ask for evidence paths, test counts, screenshots, and a commit SHA when applicable.", ["decomposition"] = "Split unrelated areas into independently testable briefs."
    };
    // An optional internal cheap reviewer may supplement the rubric. It never blocks on outage.
    public static async Task<BriefQualityResult> Evaluate(JsonObject b, Func<JsonObject, CancellationToken, Task<IReadOnlyList<string>>>? reviewer = null, CancellationToken ct = default)
    {
        var result = Score(b);
        if (reviewer is null) return result;
        try { using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct); timeout.CancelAfter(TimeSpan.FromSeconds(3));
            var warnings = await reviewer(b, timeout.Token).WaitAsync(timeout.Token); return result with { Warnings = result.Warnings.Concat(warnings.Select(BriefValidator.Clean)).ToArray() }; }
        catch (Exception) when (!ct.IsCancellationRequested) { return result; }
    }
    public static bool NeedsRewrite(BriefQualityResult quality, int attempt) => !quality.Passed && attempt == 1;
}
