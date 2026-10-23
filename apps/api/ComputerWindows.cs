using System.Text.Json;
using Dapper;
using Npgsql;
using Teammates.Compute;

namespace Teammates.Api;

public static class ComputerWindows
{
    public static void Map(WebApplication app, Platform platform)
    {
        app.MapGet("/api/bots/{id:guid}/computer/windows", async (HttpContext ctx, Guid id, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null || !await Routes.Owns(platform, user.Value, id)) return Results.Unauthorized();
            var placement = await platform.PlacementForBot(id, ct);
            var json = await platform.Compute.ControlAsync(placement.Computer,
                $"/desktops/{Uri.EscapeDataString(placement.Desktop)}/displays", "{}", ct);
            return Results.Text(json, "application/json");
        });

        app.MapPost("/api/bots/{id:guid}/computer/windows", async (HttpContext ctx, Guid id, JsonElement body, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null || !await Routes.Owns(platform, user.Value, id)) return Results.Unauthorized();
            if (!body.TryGetProperty("display", out var displayValue) || !displayValue.TryGetInt32(out var display))
                return Results.BadRequest(new { error = "display required" });
            if (display < 2 || display > BoxContract.MaxWindows)
                return Results.Conflict(new { error = "maximum windows reached" });
            var placement = await platform.PlacementForBot(id, ct);
            await using (var conn = await platform.Data.OpenConnectionAsync(ct))
            await using (var tx = await conn.BeginTransactionAsync(ct))
            {
                await conn.ExecuteAsync("SELECT pg_advisory_xact_lock(hashtextextended(@computer, 0))",
                    new { computer = placement.Computer.Value }, tx);
                var exists = await conn.ExecuteScalarAsync<int>(
                    "SELECT count(*) FROM computer_windows WHERE computer_id=@computer AND window_index=@display",
                    new { computer = Guid.Parse(placement.Computer.Value), display }, tx);
                if (exists == 0)
                {
                    var allocated = await conn.ExecuteScalarAsync<int>(
                        "SELECT count(*) FROM computer_windows WHERE computer_id=@computer", new { computer = Guid.Parse(placement.Computer.Value) }, tx);
                    if (allocated >= BoxContract.MaxWindows - 1)
                        return Results.Conflict(new { error = "maximum windows reached" });
                    await conn.ExecuteAsync("INSERT INTO computer_windows (computer_id, window_index, state) VALUES (@computer, @display, 'starting')",
                        new { computer = Guid.Parse(placement.Computer.Value), display }, tx);
                }
                await tx.CommitAsync(ct);
            }
            try
            {
            var json = await platform.Compute.ControlAsync(placement.Computer,
                $"/windows/{Uri.EscapeDataString(placement.Desktop)}/{display}", "{}", ct);
                await using var conn = await platform.Data.OpenConnectionAsync(ct);
                await conn.ExecuteAsync("UPDATE computer_windows SET state='ready' WHERE computer_id=@computer AND window_index=@display",
                    new { computer = Guid.Parse(placement.Computer.Value), display });
            return Results.Text(json, "application/json");
            }
            catch
            {
                await using var conn = await platform.Data.OpenConnectionAsync(ct);
                await conn.ExecuteAsync("DELETE FROM computer_windows WHERE computer_id=@computer AND window_index=@display AND state <> 'ready'",
                    new { computer = Guid.Parse(placement.Computer.Value), display });
                throw;
            }
        });

        app.MapPost("/api/bots/{id:guid}/computer/windows/{display:int}/owner-token", async (HttpContext ctx, Guid id, int display, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null || !await Routes.Owns(platform, user.Value, id)) return Results.Unauthorized();
            if (display < 1 || display > BoxContract.MaxWindows)
                return Results.Conflict(new { error = "invalid window" });
            var placement = await platform.PlacementForBot(id, ct);
            var json = await platform.Compute.ControlAsync(placement.Computer,
                $"/windows/{Uri.EscapeDataString(placement.Desktop)}/{display}/owner-token", "{}", ct);
            return Results.Text(json, "application/json");
        });

        app.MapDelete("/api/bots/{id:guid}/computer/windows/{display:int}", async (HttpContext ctx, Guid id, int display, CancellationToken ct) =>
        {
            var user = await Routes.RequireUser(ctx, platform);
            if (user == null || !await Routes.Owns(platform, user.Value, id)) return Results.Unauthorized();
            if (display < 2 || display > BoxContract.MaxWindows)
                return Results.Conflict(new { error = "invalid window" });
            var placement = await platform.PlacementForBot(id, ct);
            var json = await platform.Compute.ControlAsync(placement.Computer,
                $"/windows/{Uri.EscapeDataString(placement.Desktop)}/{display}/stop", "{}", ct);
            await using var conn = await platform.Data.OpenConnectionAsync(ct);
            await conn.ExecuteAsync("DELETE FROM computer_windows WHERE computer_id=@computer AND window_index=@display",
                new { computer = Guid.Parse(placement.Computer.Value), display });
            return Results.Text(json, "application/json");
        });
    }
}
