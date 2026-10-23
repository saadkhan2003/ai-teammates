using System.Text.Json;
using Dapper;
using Npgsql;

namespace Teammates.Api;

public static class PluginCli
{
    public static async Task<int> Run(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("usage: teammates plugins import|check|stats|add-openapi");
            return 2;
        }
        try
        {
            var data = NpgsqlDataSource.Create(ConnectionString());
            await using var conn = await data.OpenConnectionAsync();
            return args[0] switch
            {
                "import" => await Import(conn, args),
                "check" => await Check(data, args),
                "stats" => await Stats(conn),
                "add-openapi" => await AddOpenApi(conn, args),
                _ => Usage()
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    private static async Task<int> Import(NpgsqlConnection conn, string[] args)
    {
        var fresh = args.Contains("--fresh");
        var max = FlagInt(args, "--max-pages", 500);
        var registry = Flag(args, "--registry") ?? Environment.GetEnvironmentVariable("MCP_REGISTRY_URL") ?? McpRegistry.DefaultBase;
        var count = await PluginCatalog.ImportRegistry(conn, registry, fresh, max, CancellationToken.None);
        var stats = await PluginCatalog.Stats(conn);
        stats["touched"] = count;
        Console.WriteLine(JsonSerializer.Serialize(stats));
        return 0;
    }

    private static async Task<int> Check(NpgsqlDataSource data, string[] args)
    {
        var limit = FlagInt(args, "--limit", 5000);
        var concurrency = FlagInt(args, "--concurrency", 6);
        var count = await PluginCatalog.CheckPending(data, limit, concurrency, CancellationToken.None);
        await using var conn = await data.OpenConnectionAsync();
        var stats = await PluginCatalog.Stats(conn);
        stats["checked"] = count;
        Console.WriteLine(JsonSerializer.Serialize(stats));
        return 0;
    }

    private static async Task<int> Stats(NpgsqlConnection conn)
    {
        var stats = await PluginCatalog.Stats(conn);
        Console.WriteLine(JsonSerializer.Serialize(stats));
        return 0;
    }

    private static async Task<int> AddOpenApi(NpgsqlConnection conn, string[] args)
    {
        var file = Flag(args, "--file");
        var url = Flag(args, "--url");
        var name = Flag(args, "--name");
        OpenApiGeneration generated;
        if (!string.IsNullOrWhiteSpace(file))
        {
            var body = await File.ReadAllTextAsync(file);
            generated = OpenApiSpec.Generate(body, url ?? "", name);
        }
        else if (!string.IsNullOrWhiteSpace(url))
        {
            var blocked = await SsrfGuard.ResolveAsync(url, CancellationToken.None);
            if (blocked.Blocked)
            {
                Console.Error.WriteLine(blocked.Reason);
                return 1;
            }
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            using var response = await PluginHttp.Client.SendAsync(request);
            var body = await PluginProbe.ReadLimited(response.Content, PluginLimits.MaxSpecBytes, CancellationToken.None);
            generated = OpenApiSpec.Generate(body, url, name);
        }
        else
        {
            Console.Error.WriteLine("add-openapi needs --file or --url");
            return 2;
        }
        if (!generated.Ok || generated.Manifest == null)
        {
            Console.Error.WriteLine(generated.Error);
            return 1;
        }
        await PluginCatalog.Upsert(conn, generated.Manifest);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            id = generated.Manifest.Id,
            label = generated.Manifest.Label,
            checkStatus = generated.Manifest.CheckStatus,
            tools = generated.Manifest.Tools.Count
        }));
        return 0;
    }

    private static int Usage()
    {
        Console.Error.WriteLine("usage: teammates plugins import|check|stats|add-openapi");
        return 2;
    }

    private static string? Flag(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        if (index < 0 || index + 1 >= args.Length) return null;
        return args[index + 1];
    }

    private static int FlagInt(string[] args, string name, int fallback)
    {
        var text = Flag(args, name);
        return int.TryParse(text, out var value) && value > 0 ? value : fallback;
    }

    private static string ConnectionString()
    {
        var builder = new NpgsqlConnectionStringBuilder
        {
            Host = Environment.GetEnvironmentVariable("POSTGRES_HOST") ?? "postgres",
            Port = int.TryParse(Environment.GetEnvironmentVariable("POSTGRES_PORT"), out var port) ? port : 5432,
            Database = Environment.GetEnvironmentVariable("POSTGRES_DB") ?? "agent",
            Username = Environment.GetEnvironmentVariable("POSTGRES_USER") ?? "agent",
            Password = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD") ?? "teammates-dev"
        };
        return builder.ConnectionString;
    }
}
