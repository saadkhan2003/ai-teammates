using Dapper;
using System.Text.Json;

namespace Teammates.Api;

public static class Feedback
{
    public static void Map(WebApplication app, Platform platform)
    {
        app.MapPost("/api/feedback", async (HttpContext ctx, JsonElement body) =>
        {
            ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
            var user = await platform.UserForSession(token);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync(ctx.RequestAborted);
            if (await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@user", new { user }) != "owner") return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var message = body.TryGetProperty("message", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()?.Trim() : null;
            if (string.IsNullOrWhiteSpace(message) || message.Length > 5000) return Results.BadRequest(new { error = "Feedback must be 1–5000 characters." });
            var category = body.TryGetProperty("category", out var kind) && kind.ValueKind == JsonValueKind.String ? kind.GetString()?.Trim() : "general";
            if (string.IsNullOrWhiteSpace(category) || category.Length > 40) category = "general";
            var id = await conn.ExecuteScalarAsync<Guid>("INSERT INTO feedback(owner_user_id, category, message) VALUES (@user,@category,@message) RETURNING id", new { user, category, message });
            await platform.Audit(user.Value.ToString(), "feedback.submitted", null, null, new { feedbackId = id, category });
            return Results.Json(new { id }, statusCode: 201);
        });
    }
}
