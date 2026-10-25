using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Amazon.S3.Model;
using Dapper;

namespace Teammates.Api;

public static class AccountRoutes
{
    private static readonly AccountRateLimiter Limits = new();
    private const int AvatarLimit = 2 * 1024 * 1024;
    private const int AttachmentLimit = 2 * 1024 * 1024;
    private static readonly HttpClient WorkerHealth = new() { Timeout = TimeSpan.FromSeconds(2) };
    sealed class BillingRow
    {
        public string PlanId { get; set; } = "free";
        public int CreditBalance { get; set; } = 500;
        public int CreditAllowance { get; set; } = 500;
        public DateTime PeriodStart { get; set; } = DateTime.UtcNow;
        public string Provider { get; set; } = "mock";
    }

    sealed class IdentityRow
    {
        public string Provider { get; set; } = "";
        public string Label { get; set; } = "";
        public string Email { get; set; } = "";
    }

    sealed class InvoiceRow
    {
        public Guid Id { get; set; }
        public string Number { get; set; } = "";
        public string PlanId { get; set; } = "";
        public int AmountCents { get; set; }
        public string Currency { get; set; } = "usd";
        public string Status { get; set; } = "paid";
        public string Provider { get; set; } = "mock";
        public DateTime IssuedAt { get; set; }
    }

    sealed class AdminRow
    {
        public Guid Id { get; set; }
        public string Username { get; set; } = "";
        public string DisplayName { get; set; } = "";
        public string Email { get; set; } = "";
        public string Role { get; set; } = "";
        public string Status { get; set; } = "";
        public string PlanId { get; set; } = "free";
        public int CreditBalance { get; set; }
        public int CreditAllowance { get; set; }
        public long ModelCalls { get; set; }
        public decimal CostUsd { get; set; }
    }

    public static void Map(WebApplication app, Platform platform)
    {
        IBillingProvider provider;
        try
        {
            provider = BillingProviders.Create(app.Configuration["BILLING_PROVIDER"], key => app.Configuration[key]);
        }
        catch (BillingProviderException ex)
        {
            app.Logger.LogWarning("billing provider fell back to mock: {Message}", ex.Message);
            provider = new MockBillingProvider();
        }

        app.MapGet("/api/account", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            return Results.Json(await Profile(conn, user.Value));
        });

        app.MapPatch("/api/account", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (body.TryGetProperty("displayName", out _))
            {
                var name = Str(body, "displayName");
                if (!AccountInput.ValidDisplayName(name)) return Results.BadRequest(new { error = "Enter a name up to 80 characters." });
                await conn.ExecuteAsync("UPDATE users SET display_name=@name WHERE id=@id", new { id = user, name = name!.Trim() });
            }
            if (body.TryGetProperty("email", out _))
            {
                var email = Str(body, "email")?.Trim() ?? "";
                if (email.Length > 0 && !AccountInput.ValidEmail(email)) return Results.BadRequest(new { error = "Enter a valid email." });
                await conn.ExecuteAsync("UPDATE users SET email=@email WHERE id=@id", new { id = user, email });
            }
            if (body.TryGetProperty("avatarUrl", out _))
            {
                var avatar = Str(body, "avatarUrl") ?? "";
                if (avatar != "/api/account/avatar" && !AccountInput.ValidAvatar(avatar)) return Results.BadRequest(new { error = "Use a small image or an https link." });
                // The profile response normalizes uploaded object keys to this owner-scoped URL.
                // Preserve that stored key when the existing profile form submits it unchanged.
                if (avatar != "/api/account/avatar")
                    await conn.ExecuteAsync("UPDATE users SET avatar_url=@avatar WHERE id=@id", new { id = user, avatar });
            }
            if (body.TryGetProperty("productUpdates", out var updates) && updates.ValueKind is JsonValueKind.True or JsonValueKind.False)
                await conn.ExecuteAsync("UPDATE users SET product_updates=@value WHERE id=@id", new { id = user, value = updates.GetBoolean() });
            return Results.Json(await Profile(conn, user.Value));
        });

        app.MapPost("/api/account/password", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            if (!SameOrigin(ctx)) return Results.StatusCode(403);
            if (!Limits.Allow($"password:{user}")) return Results.StatusCode(429);
            var current = Text(body, "currentPassword"); var next = Text(body, "newPassword");
            if (next.Length < 12 || next.Length > 256 || !next.Any(char.IsLetter) || !next.Any(char.IsDigit)) return Results.BadRequest(new { error = "Use at least 12 characters with letters and numbers, up to 256 characters." });
            await using var db = await platform.Data.OpenConnectionAsync();
            var hash = await db.ExecuteScalarAsync<string>("SELECT password_hash FROM users WHERE id=@user", new { user });
            if (!Passwords.Verify(current, hash ?? "")) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            await db.ExecuteAsync("UPDATE users SET password_hash=@hash WHERE id=@user", new { user, hash = Passwords.Hash(next) });
            await platform.Audit(user.Value.ToString(), "account.password_changed", null, null, new { });
            return Results.Json(new { ok = true });
        });
        app.MapPost("/api/account/identities", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var method = (Str(body, "provider") ?? "").ToLowerInvariant();
            if (!SignInMethods.CanConnect(method)) return Results.BadRequest(new { error = "That sign-in method is not available." });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var email = await conn.ExecuteScalarAsync<string>("SELECT coalesce(email, '') FROM users WHERE id=@id", new { id = user }) ?? "";
            await conn.ExecuteAsync(
                """
                INSERT INTO user_identities (user_id, provider, label, email)
                VALUES (@id, @method, @label, @email)
                ON CONFLICT (user_id, provider) DO UPDATE SET email=EXCLUDED.email, connected_at=now()
                """,
                new { id = user, method, label = SignInMethods.Label(method), email });
            return Results.Json(await Profile(conn, user.Value));
        });

        app.MapDelete("/api/account/identities/{provider}", async (HttpContext ctx, string provider) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var method = provider.ToLowerInvariant();
            if (method == "password") return Results.BadRequest(new { error = "Password stays connected." });
            if (!SignInMethods.CanConnect(method)) return Results.BadRequest(new { error = "That sign-in method is not available." });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var removed = await conn.ExecuteAsync("DELETE FROM user_identities WHERE user_id=@id AND provider=@method", new { id = user, method });
            if (removed == 0) return Results.NotFound();
            return Results.Json(await Profile(conn, user.Value));
        });

        app.MapDelete("/api/account", async (HttpContext ctx, [Microsoft.AspNetCore.Mvc.FromBody] JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            if (!AccountSecurityPolicy.HasDeleteConfirmation(Text(body, "confirmation")) && Text(body, "confirm") != "DELETE") return Results.BadRequest(new { error = "confirmation_mismatch" });
            await using var db = await platform.Data.OpenConnectionAsync(); var hash = await db.ExecuteScalarAsync<string>("SELECT password_hash FROM users WHERE id=@user", new { user });
            if (!Passwords.Verify(Text(body, "password"), hash ?? "")) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            var role = await db.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@user", new { user });
            var owners = await db.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE role='owner' AND status='active'");
            if (!AccountInput.CanDelete(role ?? "member", owners)) return Results.Conflict(new { error = "The only owner cannot delete this account." });
            await platform.Audit(user.Value.ToString(), "account.deleted", null, null, new { policy = "immediate" }); await db.ExecuteAsync("DELETE FROM users WHERE id=@user", new { user });
            await platform.SessionChanged(user.Value);
            ctx.Response.Cookies.Delete("teammates_session"); return Results.Json(new { ok = true, policy = "immediate" });
        });

        app.MapGet("/api/billing", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            return Results.Json(await Billing(conn, platform, user.Value));
        });

        app.MapPost("/api/billing/checkout", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            var configured = await conn.QuerySingleOrDefaultAsync<BillingPlan>("SELECT " + UsageMeter.PlanColumns() + " FROM billing_plans WHERE id=@id", new { id = Str(body, "planId") });
            if (configured == null) return Results.BadRequest(new { error = "Unknown plan." });
            var plan = new Plan(configured.Id, configured.Name, "Weekly usage plan", (int)(configured.PriceUsd * 100), (int)Math.Min(1_000_000, configured.WeeklyCredits * 4), []);
            var planId = plan.Id;
            var balance = plan.MonthlyCredits;
            var allowance = balance;
            var checkout = provider.Checkout(new CheckoutRequest(planId, plan.PriceCents, "usd", user.Value.ToString()));
            if (checkout.ChargesCard || checkout.Provider != BillingProviders.Mock || checkout.Status != "completed")
                return Results.Json(new { error = "Only the mock provider is available." }, statusCode: 409);
            await conn.ExecuteAsync(
                """
                INSERT INTO billing_accounts (user_id, plan_id, credit_balance, credit_allowance, period_start, provider, updated_at)
                VALUES (@id, @planId, @balance, @allowance, date_trunc('month', now()), 'mock', now())
                ON CONFLICT (user_id) DO UPDATE SET plan_id=@planId, credit_balance=@balance, credit_allowance=@allowance, period_start=date_trunc('month', now()), provider='mock', updated_at=now()
                """,
                new { id = user, planId, balance, allowance });
            string? invoiceNumber = null;
            if (BillingMath.CreatesInvoice(plan))
            {
                invoiceNumber = "INV-" + DateTime.UtcNow.ToString("yyyyMMdd") + "-" + Guid.NewGuid().ToString("N")[..6].ToUpperInvariant();
                await conn.ExecuteAsync(
                    """
                    INSERT INTO invoices (user_id, number, plan_id, amount_cents, currency, status, provider)
                    VALUES (@id, @invoiceNumber, @planId, @amount, 'usd', 'paid', 'mock')
                    """,
                    new { id = user, invoiceNumber, planId, amount = plan.PriceCents });
            }
            await conn.ExecuteAsync("UPDATE users SET plan_id=@planId WHERE id=@id", new { id = user, planId });
            platform.Usage.Invalidate(user.Value);
            await platform.Audit(user.Value.ToString(), "billing.checkout", null, null, new { planId, provider = checkout.Provider, chargesCard = false });
            return Results.Json(new { provider = checkout.Provider, status = checkout.Status, planId, chargesCard = false, checkoutUrl = (string?)null, invoiceNumber });
        });

        app.MapGet("/api/help", () => Results.Json(new
        {
            faq = HelpContent.Faq.Select(item => new { id = item.Id, question = item.Question, answer = item.Answer }),
            docs = HelpContent.Docs.Select(item => new { href = item.Href, title = item.Title, detail = item.Detail }),
            topics = HelpContent.Topics
        }));

        app.MapPost("/api/support", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var email = Str(body, "email")?.Trim() ?? "";
            var topic = (Str(body, "topic") ?? "").Trim().ToLowerInvariant();
            var message = Str(body, "message")?.Trim() ?? "";
            if (!AccountInput.ValidEmail(email)) return Results.BadRequest(new { error = "Enter a valid email." });
            if (!HelpContent.Topics.Contains(topic)) return Results.BadRequest(new { error = "Choose a topic." });
            if (message.Length is < 1 or > 4000) return Results.BadRequest(new { error = "Write a message up to 4000 characters." });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var id = await conn.ExecuteScalarAsync<Guid>(
                "INSERT INTO support_messages (user_id, email, topic, body) VALUES (@user, @email, @topic, @message) RETURNING id",
                new { user, email, topic, message });
            return Results.Json(new { id }, statusCode: 201);
        });

        app.MapGet("/api/legal/terms", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            var custom = await conn.ExecuteScalarAsync<string>("SELECT value FROM platform_settings WHERE key='legal_terms'");
            if (!string.IsNullOrWhiteSpace(custom)) return Results.Json(new { placeholder = false, title = LegalContent.Terms.Title, banner = "", body = custom });
            return Results.Json(new { placeholder = true, title = LegalContent.Terms.Title, banner = LegalContent.Banner, body = LegalContent.Terms.Body });
        });
        app.MapGet("/api/legal/privacy", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            var custom = await conn.ExecuteScalarAsync<string>("SELECT value FROM platform_settings WHERE key='legal_privacy'");
            if (!string.IsNullOrWhiteSpace(custom)) return Results.Json(new { placeholder = false, title = LegalContent.Privacy.Title, banner = "", body = custom });
            return Results.Json(new { placeholder = true, title = LegalContent.Privacy.Title, banner = LegalContent.Banner, body = LegalContent.Privacy.Body });
        });

        app.MapGet("/api/status", async (HttpContext ctx) =>
        {
            var database = false; var computers = false; var worker = false; var computerCount = 0;
            try
            {
                await using var db = await platform.Data.OpenConnectionAsync(); database = await db.ExecuteScalarAsync<int>("SELECT 1") == 1;
                computerCount = await db.ExecuteScalarAsync<int>("SELECT count(*) FROM user_computers");
            }
            catch { }
            try { computers = (await platform.Compute.HealthCheckAsync(CancellationToken.None)).Healthy && platform.Compute.ComputerIsolationHealthy; } catch { computers = false; }
            try
            {
                var workerHealthUrl = platform.Configuration["WORKER_HEALTH_URL"] ?? "http://agent:7710/health";
                using var response = await WorkerHealth.GetAsync(workerHealthUrl, ctx.RequestAborted);
                worker = response.IsSuccessStatusCode;
            }
            catch { worker = false; }
            var board = JsonSerializer.SerializeToNode(new { indicator = "major", description = "Status history is temporarily unavailable", services = Array.Empty<object>(), incidents = Array.Empty<object>() })!;
            try
            {
                await using var conn = await platform.Data.OpenConnectionAsync();
                board = JsonSerializer.SerializeToNode(await UptimeBoard.Load(conn))!;
            }
            catch { }
            board["components"] = JsonSerializer.SerializeToNode(new object[] {
                new { name = "API", status = "operational" },
                new { name = "Database", status = database ? "operational" : "outage" },
                new { name = "Computers", status = computers ? "operational" : "degraded", available = computerCount },
                new { name = "Worker", status = worker ? "operational" : "outage" }
            });
            return Results.Json(board);
        });

        app.MapGet("/api/changelog", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            var extra = await conn.QueryAsync<(Guid Id, DateTime StartsAt, string Title, string Body)>(
                "SELECT id, coalesce(starts_at, created_at) AS starts_at, title, body FROM announcements WHERE kind='changelog' AND published=true ORDER BY created_at DESC");
            var entries = ChangelogContent.Entries.Select(item => new { id = item.Id, date = item.Date, title = item.Title, body = item.Body })
                .Concat(extra.Select(item => new { id = item.Id.ToString(), date = item.StartsAt.ToString("yyyy-MM-dd"), title = item.Title, body = item.Body }));
            return Results.Json(new { entries });
        });

        app.MapGet("/api/admin/accounts", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (!Access.CanEnterAdmin(await Role(conn, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var (modelId, modelLabel) = await Model(conn);
            var allowances = await Allowances(conn);
            var rows = (await conn.QueryAsync<AdminRow>(
                """
                SELECT u.id, u.username, u.display_name, coalesce(u.email, '') AS email, u.role, u.status,
                       u.plan_id AS plan_id,
                       coalesce(b.credit_balance, 500) AS credit_balance,
                       coalesce(b.credit_allowance, 500) AS credit_allowance,
                       count(m.id) AS model_calls,
                       coalesce(sum(m.cost_usd), 0) AS cost_usd
                FROM users u
                LEFT JOIN billing_accounts b ON b.user_id = u.id
                LEFT JOIN model_calls m ON m.owner_id = u.id
                GROUP BY u.id, b.plan_id, b.credit_balance, b.credit_allowance
                ORDER BY u.created_at
                """)).ToList();
            foreach (var row in rows)
            {
                var summary = await platform.Usage.SummaryAsync(row.Id, fresh: true);
                row.CreditAllowance = (int)Math.Min(int.MaxValue, summary.Allowance);
                row.CreditBalance = (int)Math.Min(int.MaxValue, Math.Max(0, summary.Allowance - summary.UsedCredits));
            }
            var query = ctx.Request.Query["q"].ToString();
            var users = rows
                .Where(row => AccountSearch.Matches(query, row.Username, row.DisplayName, row.Email))
                .Select(row => new
                {
                    id = row.Id,
                    username = row.Username,
                    displayName = row.DisplayName,
                    email = row.Email,
                    role = row.Role,
                    status = row.Status,
                    planId = row.PlanId,
                    creditBalance = row.CreditBalance,
                    creditAllowance = row.CreditAllowance,
                    modelCalls = row.ModelCalls,
                    costUsd = row.CostUsd,
                    suspended = row.Status == "disabled"
                });
            return Results.Json(new
            {
                runtimeProvider = platform.LlmProvider,
                modelId,
                modelLabel,
                allowances,
                users
            });
        });

        app.MapPut("/api/admin/platform", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (!Access.IsStaff(await Role(conn, user.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var modelId = Str(body, "modelId")?.Trim() ?? "";
            var modelLabel = Str(body, "modelLabel")?.Trim() ?? "";
            if (!PlatformModel.ValidId(modelId) || !PlatformModel.ValidLabel(modelLabel))
                return Results.BadRequest(new { error = "Enter a model id and a label." });
            if (!body.TryGetProperty("allowances", out var raw) || raw.ValueKind != JsonValueKind.Object)
                return Results.BadRequest(new { error = "Enter a credit grant for each plan." });
            var knownPlans = (await conn.QueryAsync<string>("SELECT id FROM billing_plans")).ToHashSet(StringComparer.Ordinal);
            var allowances = new Dictionary<string, int>();
            foreach (var value in raw.EnumerateObject())
            {
                if (!knownPlans.Contains(value.Name) || !value.Value.TryGetInt32(out var credits) || credits < 0 || credits > 1_000_000)
                    return Results.BadRequest(new { error = "Enter a valid weekly credit grant for each plan." });
                allowances[value.Name] = credits;
            }
            if (allowances.Count == 0) return Results.BadRequest(new { error = "Enter a credit grant for a plan." });
            foreach (var (id, credits) in allowances)
                await conn.ExecuteAsync("UPDATE billing_plans SET weekly_credits=@credits,updated_at=now() WHERE id=@id", new { id, credits });
            platform.Usage.InvalidateAll();
            await Upsert(conn, "model_id", modelId);
            await Upsert(conn, "model_label", modelLabel);
            await Upsert(conn, "credit_allowances", JsonSerializer.Serialize(allowances));
            await platform.Audit(user.Value.ToString(), "platform.settings", null, null, new { modelId, modelLabel });
            return Results.Json(new { modelId, modelLabel, allowances, runtimeProvider = platform.LlmProvider });
        });

        app.MapPatch("/api/admin/users/{id:guid}/billing", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var actor = await User(ctx, platform);
            if (actor == null) return Results.Unauthorized();
            await using var conn = await platform.Data.OpenConnectionAsync();
            if (!Access.IsStaff(await Role(conn, actor.Value))) return Results.Json(new { error = "forbidden" }, statusCode: 403);
            var exists = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE id=@id", new { id });
            if (exists == 0) return Results.NotFound();
            await EnsureBilling(conn, id);
            var current = await conn.QuerySingleAsync<BillingRow>("SELECT plan_id, credit_balance, credit_allowance, period_start, provider FROM billing_accounts WHERE user_id=@id", new { id });
            var planId = current.PlanId;
            var balance = current.CreditBalance;
            var allowance = current.CreditAllowance;
            if (body.TryGetProperty("planId", out _))
            {
                var nextPlan = Str(body, "planId");
                var configured = await conn.QuerySingleOrDefaultAsync<BillingPlan>("SELECT " + UsageMeter.PlanColumns() + " FROM billing_plans WHERE id=@nextPlan", new { nextPlan });
                if (configured == null) return Results.BadRequest(new { error = "Unknown plan." });
                planId = configured.Id;
                balance = allowance = (int)Math.Min(1_000_000, configured.WeeklyCredits * 4);
            }
            int? setTo = body.TryGetProperty("creditBalance", out var setEl) && setEl.TryGetInt32(out var setValue) ? setValue : null;
            int? delta = body.TryGetProperty("creditDelta", out var deltaEl) && deltaEl.TryGetInt32(out var deltaValue) ? deltaValue : null;
            if (setTo == null && delta == null && planId == current.PlanId && !body.TryGetProperty("planId", out _))
                return Results.BadRequest(new { error = "Nothing to change." });
            try
            {
                if (setTo != null || delta != null) balance = BillingMath.AdjustBalance(balance, setTo, delta);
            }
            catch (ArgumentOutOfRangeException)
            {
                return Results.BadRequest(new { error = "Credits must be between 0 and 1000000." });
            }
            await conn.ExecuteAsync(
                "UPDATE billing_accounts SET plan_id=@planId, credit_balance=@balance, credit_allowance=@allowance, provider='mock', updated_at=now() WHERE user_id=@id",
                new { id, planId, balance, allowance });
            await conn.ExecuteAsync("UPDATE users SET plan_id=@planId WHERE id=@id", new { id, planId });
            var summary = await platform.Usage.SummaryAsync(id, fresh: true);
        var usage = await conn.QuerySingleAsync<(long Calls, decimal Cost, double Latency)>("SELECT count(*) AS calls,coalesce(sum(cost_usd),0) AS cost,coalesce(avg(latency_ms),0)::float8 AS latency FROM model_calls WHERE owner_id=@id AND created_at >= date_trunc('month',now())", new { id });
        var breakdown = await conn.QueryAsync("SELECT role AS category,count(*) AS calls,coalesce(sum(cost_usd),0) AS cost_usd FROM model_calls WHERE owner_id=@id AND created_at >= date_trunc('month',now()) GROUP BY role ORDER BY cost_usd DESC", new { id });
        var published = await conn.ExecuteScalarAsync<string>("SELECT plans::text FROM billing_configuration WHERE id=true");
            var remaining = (int)Math.Min(int.MaxValue, Math.Max(0, summary.Allowance - summary.UsedCredits));
            var grant = delta ?? (setTo is { } requested ? requested - remaining : 0);
            if (grant != 0) await conn.ExecuteAsync("INSERT INTO credit_ledger(user_id,kind,credits,note,actor_id) VALUES(@id,'grant',@grant,'staff balance adjustment',@actor)", new { id, grant, actor });
            platform.Usage.Invalidate(id);
            await platform.Audit(actor.Value.ToString(), "billing.adjust", null, null, new { userId = id, planId, balance });
            return Results.Json(new { id, planId, creditBalance = balance, creditAllowance = allowance });
        });
        app.MapGet("/api/pricing", async () =>
        {
            await using var db = await platform.Data.OpenConnectionAsync();
            var config = await db.QuerySingleOrDefaultAsync<(decimal? Rate, string Plans)>("SELECT currency_rate_pkr_per_usd AS rate,plans::text FROM billing_configuration WHERE id=true");
            object plans = config.Plans is null ? Array.Empty<object>() : JsonSerializer.Deserialize<JsonElement>(config.Plans);
            return Results.Json(new { currencyRatePkrPerUsd = config.Rate, plans });
        });
        app.MapGet("/api/admin/billing/config", async (HttpContext ctx) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied;
            await using var db = await platform.Data.OpenConnectionAsync();
            var config = await db.QuerySingleOrDefaultAsync<(decimal? Rate, string Plans)>("SELECT currency_rate_pkr_per_usd AS rate,plans::text FROM billing_configuration WHERE id=true");
            object plans = config.Plans is null ? Array.Empty<object>() : JsonSerializer.Deserialize<JsonElement>(config.Plans);
            return Results.Json(new { currencyRatePkrPerUsd = config.Rate, plans });
        });
        app.MapPut("/api/admin/billing/config", async (HttpContext ctx, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            decimal? rate = body.TryGetProperty("currencyRatePkrPerUsd", out var rateElement) && rateElement.ValueKind == JsonValueKind.Number ? rateElement.GetDecimal() : null;
            if (rate is <= 0 or > 100000) return Results.BadRequest(new { error = "invalid_exchange_rate" });
            if (!body.TryGetProperty("plans", out var plans) || plans.ValueKind != JsonValueKind.Array || plans.GetArrayLength() > 20) return Results.BadRequest(new { error = "invalid_plans" });
            foreach (var plan in plans.EnumerateArray())
            {
                if (plan.ValueKind != JsonValueKind.Object || !plan.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(name.GetString()) || name.GetString()!.Length > 80) return Results.BadRequest(new { error = "invalid_plans" });
                if (plan.TryGetProperty("priceUsd", out var price) && price.ValueKind != JsonValueKind.Null && (price.ValueKind != JsonValueKind.Number || price.GetDecimal() < 0 || price.GetDecimal() > 1000000)) return Results.BadRequest(new { error = "invalid_plans" });
            }
            var plansJson = plans.GetRawText(); await using var db = await platform.Data.OpenConnectionAsync();
            await db.ExecuteAsync("INSERT INTO billing_configuration(id,currency_rate_pkr_per_usd,plans,updated_by,updated_at) VALUES(true,@rate,@plans::jsonb,@user,now()) ON CONFLICT(id) DO UPDATE SET currency_rate_pkr_per_usd=excluded.currency_rate_pkr_per_usd,plans=excluded.plans,updated_by=excluded.updated_by,updated_at=now()", new { rate, plans = plansJson, user });
            await platform.Audit(user!.Value.ToString(), "billing.configuration_updated", null, null, new { planCount = plans.GetArrayLength(), rateConfigured = rate.HasValue });
            return Results.Json(new { ok = true });
        });
        app.MapPost("/api/auth/login/totp", async (HttpContext ctx, JsonElement body) =>
        {
            if (!SameOrigin(ctx)) return Results.StatusCode(403);
            ctx.Request.Cookies.TryGetValue("teammates_login_challenge", out var challenge);
            if (string.IsNullOrWhiteSpace(challenge) || !Limits.Allow("login-totp:" + TokenDigest(challenge))) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            var digest = TokenDigest(challenge);
            await using var db = await platform.Data.OpenConnectionAsync();
            var user = await db.ExecuteScalarAsync<Guid?>("SELECT c.user_id FROM login_totp_challenges c JOIN users u ON u.id=c.user_id WHERE c.token_hash=@digest AND c.expires_at>now() AND u.status='active'", new { digest });
            if (user is null) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            var row = await db.QuerySingleAsync<(byte[]? Cipher, byte[]? Nonce, string[] Recovery)>("SELECT totp_secret,totp_nonce,recovery_code_hashes FROM users WHERE id=@user AND totp_enabled=true", new { user });
            if (row.Cipher is null || row.Nonce is null) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            var code = Text(body, "code"); var secret = KeyEncryption.Decrypt(platform.MasterKey, user.Value, user.Value, "TOTP", KeyEncryption.KeyVersion, row.Cipher, row.Nonce);
            var validTotp = Totp.Verify(secret, code);
            var recoveryHash = Hash(code);
            if (!validTotp && !row.Recovery.Contains(recoveryHash, StringComparer.Ordinal)) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            if (!validTotp) await db.ExecuteAsync("UPDATE users SET recovery_code_hashes=array_remove(recovery_code_hashes,@recoveryHash) WHERE id=@user", new { user, recoveryHash });
            await db.ExecuteAsync("DELETE FROM login_totp_challenges WHERE token_hash=@digest", new { digest });
            ctx.Response.Cookies.Delete("teammates_login_challenge");
            await EstablishSession(ctx, platform, user.Value);
            return Results.Json(new { ok = true });
        });
        app.MapPut("/api/account/profile", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var name = Text(body, "displayName").Trim(); var timezone = Text(body, "timezone").Trim(); var locale = Text(body, "locale").Trim();
            if (name.Length is < 1 or > 80 || !RoutineTime.TryZone(timezone, out _) || locale is not ("en" or "ur")) return Results.BadRequest(new { error = "invalid_profile" });
            var prefs = body.TryGetProperty("notifications", out var p) && p.ValueKind == JsonValueKind.Object ? p.GetRawText() : "{}";
            try { using var parsed = JsonDocument.Parse(prefs); if (parsed.RootElement.ValueKind != JsonValueKind.Object) return Results.BadRequest(); } catch { return Results.BadRequest(); }
            await using var db = await platform.Data.OpenConnectionAsync();
            await db.ExecuteAsync("UPDATE users SET display_name=@name,timezone=@timezone,locale=@locale,notification_preferences=@prefs::jsonb WHERE id=@user", new { user, name, timezone, locale, prefs });
            await platform.Audit(user.Value.ToString(), "account.profile_updated", null, null, new { timezone, locale });
            return Results.Json(new { ok = true });
        });
        app.MapPost("/api/account/email", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var email = Text(body, "email").Trim();
            if (email.Length > 254 || !System.Net.Mail.MailAddress.TryCreate(email, out var parsed) || parsed.Address != email) return Results.BadRequest(new { error = "invalid_email" });
            // Sending is not configured. Do not alter the account or reveal whether the address belongs to anyone.
            await platform.Audit(user.Value.ToString(), "account.email_verification_requested", null, null, new { requested = true });
            return Results.Json(new { ok = true, verificationSent = false, message = "Email sending is not configured. Your email has not changed." });
        });
        app.MapGet("/api/account/sessions", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            var token = TokenHash(ctx); await using var db = await platform.Data.OpenConnectionAsync();
            await db.ExecuteAsync("UPDATE sessions SET last_active_at=now() WHERE token_hash=@token AND user_id=@user", new { user, token });
            var rows = await db.QueryAsync<(Guid Id, string UserAgent, string? Ip, DateTime LastActive, bool Current)>("SELECT id,user_agent,host(ip_address) AS ip,last_active_at AS last_active,token_hash=@token AS current FROM sessions WHERE user_id=@user AND expires_at>now() ORDER BY last_active_at DESC", new { user, token });
            return Results.Json(rows.Select(r => new { id = r.Id, device = DeviceName(r.UserAgent), browser = BrowserName(r.UserAgent), ip = r.Ip, lastActive = r.LastActive, current = r.Current }));
        });
        app.MapDelete("/api/account/sessions/{id:guid}", async (HttpContext ctx, Guid id) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            await using var db = await platform.Data.OpenConnectionAsync(); var targetOwner = await db.ExecuteScalarAsync<Guid?>("SELECT user_id FROM sessions WHERE id=@id AND token_hash<>@token", new { id, token = TokenHash(ctx) });
            if (targetOwner is null || !AccountSecurityPolicy.CanRevokeSession(targetOwner.Value, user.Value, false)) return Results.NotFound();
            var count = await db.ExecuteAsync("DELETE FROM sessions WHERE id=@id AND user_id=@user AND token_hash<>@token", new { id, user, token = TokenHash(ctx) });
            await platform.SessionChanged(user.Value);
            if (count > 0) await platform.Audit(user.Value.ToString(), "account.session_revoked", null, null, new { });
            return count == 0 ? Results.NotFound() : Results.Json(new { ok = true });
        });
        app.MapPost("/api/account/sessions/revoke-others", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            await using var db = await platform.Data.OpenConnectionAsync(); var count = await db.ExecuteAsync("DELETE FROM sessions WHERE user_id=@user AND token_hash<>@token", new { user, token = TokenHash(ctx) });
            await platform.SessionChanged(user.Value);
            await platform.Audit(user.Value.ToString(), "account.sessions_revoked", null, null, new { count }); return Results.Json(new { ok = true, revoked = count });
        });
        app.MapPost("/api/account/totp/setup", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            await using var db = await platform.Data.OpenConnectionAsync();
            if (await db.ExecuteScalarAsync<bool>("SELECT totp_enabled FROM users WHERE id=@user", new { user })) return Results.Conflict(new { error = "already_enabled" });
            var secret = Totp.NewSecret(); var (cipher, nonce) = KeyEncryption.Encrypt(platform.MasterKey, user.Value, user.Value, "TOTP", KeyEncryption.KeyVersion, secret);
            await db.ExecuteAsync("UPDATE users SET totp_secret=@cipher,totp_nonce=@nonce,totp_enabled=false WHERE id=@user", new { user, cipher, nonce });
            var b32 = Base32(secret); var account = Uri.EscapeDataString("Teammates"); var label = Uri.EscapeDataString($"Teammates:{user.Value}");
            return Results.Json(new { secret = b32, otpauth = $"otpauth://totp/{label}?secret={b32}&issuer={account}&algorithm=SHA1&digits=6&period=30" });
        });
        app.MapPost("/api/account/totp/verify", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403); if (!Limits.Allow($"totp:{user}")) return Results.StatusCode(429);
            await using var db = await platform.Data.OpenConnectionAsync(); var row = await db.QuerySingleOrDefaultAsync<(byte[]? Cipher, byte[]? Nonce)>("SELECT totp_secret,totp_nonce FROM users WHERE id=@user", new { user });
            if (row.Cipher is null || row.Nonce is null) return Results.BadRequest(new { error = "setup_required" });
            // Column is encrypted using a stable per-user purpose identifier.
            var secret = KeyEncryption.Decrypt(platform.MasterKey, user.Value, user.Value, "TOTP", KeyEncryption.KeyVersion, row.Cipher, row.Nonce);
            if (!Totp.Verify(secret, Text(body, "code"))) return Results.BadRequest(new { error = "invalid_code" });
            var recovery = Enumerable.Range(0, 8).Select(_ => Convert.ToHexString(RandomNumberGenerator.GetBytes(5)).ToLowerInvariant()).ToArray();
            await db.ExecuteAsync("UPDATE users SET totp_enabled=true,recovery_code_hashes=@hashes WHERE id=@user", new { user, hashes = recovery.Select(Hash).ToArray() });
            await platform.Audit(user.Value.ToString(), "account.totp_enabled", null, null, new { }); return Results.Json(new { recoveryCodes = recovery });
        });
        app.MapPost("/api/account/totp/disable", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            await using var db = await platform.Data.OpenConnectionAsync(); var hash = await db.ExecuteScalarAsync<string>("SELECT password_hash FROM users WHERE id=@user", new { user });
            if (!Passwords.Verify(Text(body, "password"), hash ?? "")) return Results.Json(new { error = "invalid_credentials" }, statusCode: 401);
            await db.ExecuteAsync("UPDATE users SET totp_secret=NULL,totp_nonce=NULL,totp_enabled=false,recovery_code_hashes='{}' WHERE id=@user", new { user });
            await platform.Audit(user.Value.ToString(), "account.totp_disabled", null, null, new { }); return Results.Json(new { ok = true });
        });
        app.MapPost("/api/account/avatar", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var form = await ctx.Request.ReadFormAsync(); var file = form.Files.GetFile("avatar"); if (file is null || file.Length is < 1 or > AvatarLimit) return Results.BadRequest(new { error = "avatar_size_limit_2mb" });
            var mime = file.ContentType.ToLowerInvariant(); if (mime is not ("image/png" or "image/jpeg" or "image/webp")) return Results.BadRequest(new { error = "avatar_type_must_be_png_jpeg_or_webp" });
            await using var verification = file.OpenReadStream(); var header = new byte[12]; var read = await verification.ReadAsync(header);
            var signatureValid = mime switch
            {
                "image/png" => read >= 8 && header.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }),
                "image/jpeg" => read >= 3 && header[0] == 0xff && header[1] == 0xd8 && header[2] == 0xff,
                "image/webp" => read >= 12 && Encoding.ASCII.GetString(header, 0, 4) == "RIFF" && Encoding.ASCII.GetString(header, 8, 4) == "WEBP",
                _ => false
            };
            if (!signatureValid) return Results.BadRequest(new { error = "invalid_image" });
            var ext = mime == "image/png" ? "png" : mime == "image/webp" ? "webp" : "jpg"; var key = $"user-avatars/{user.Value:N}.{ext}";
            await using var stream = file.OpenReadStream(); await platform.S3.PutObjectAsync(new PutObjectRequest { BucketName = platform.Bucket, Key = key, InputStream = stream, ContentType = mime });
            await using var db = await platform.Data.OpenConnectionAsync(); await db.ExecuteAsync("UPDATE users SET avatar_url=@url WHERE id=@user", new { user, url = key });
            await platform.Audit(user.Value.ToString(), "account.avatar_updated", null, null, new { contentType = mime, size = file.Length });
            return Results.Json(new { ok = true, avatarUrl = "/api/account/avatar" });
        }).DisableAntiforgery();
        app.MapGet("/api/account/avatar", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized();
            await using var db = await platform.Data.OpenConnectionAsync(); var objectKey = await db.ExecuteScalarAsync<string>("SELECT avatar_url FROM users WHERE id=@user", new { user });
            if (string.IsNullOrWhiteSpace(objectKey)) return Results.NotFound();
            var obj = await platform.S3.GetObjectAsync(platform.Bucket, objectKey); return Results.Stream(obj.ResponseStream, obj.Headers.ContentType);
        });
        app.MapPost("/api/support/tickets", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var category = Text(body, "category"); var subject = Text(body, "subject").Trim(); var message = Text(body, "message").Trim();
            if (!Limits.Allow($"ticket:{user}", 5, TimeSpan.FromHours(1))) return Results.StatusCode(429);
            if (category is not ("account" or "billing" or "bug" or "feedback" or "other") || subject.Length is < 3 or > 160 || message.Length is < 10 or > 10000) return Results.BadRequest(new { error = "invalid_ticket" });
            var name = Text(body, "attachmentName"); var type = Text(body, "attachmentType"); byte[]? data = null;
            if (body.TryGetProperty("attachmentBase64", out var att) && att.ValueKind == JsonValueKind.String)
            {
                try { data = Convert.FromBase64String(att.GetString() ?? ""); } catch { return Results.BadRequest(new { error = "invalid_attachment" }); }
                if (data.Length > AttachmentLimit || name.Length > 180 || type.Length > 120) return Results.BadRequest(new { error = "attachment_limit_2mb" });
                if (type is not ("image/png" or "image/jpeg" or "application/pdf" or "text/plain")) return Results.BadRequest(new { error = "unsupported_attachment_type" });
            }
            await using var db = await platform.Data.OpenConnectionAsync(); await using var tx = await db.BeginTransactionAsync();
            var id = await db.ExecuteScalarAsync<Guid>("INSERT INTO support_tickets(user_id,category,subject) VALUES(@user,@category,@subject) RETURNING id", new { user, category, subject }, tx);
            await db.ExecuteAsync("INSERT INTO support_ticket_messages(ticket_id,author_user_id,body,attachment_name,attachment_content_type,attachment_data) VALUES(@id,@user,@message,@name,@type,@data)", new { id, user, message, name = data is null ? null : name, type = data is null ? null : type, data }, tx); await tx.CommitAsync();
            await platform.Audit(user.Value.ToString(), "support.ticket_created", null, null, new { ticketId = id, category }); return Results.Json(new { id, status = "open" });
        });
        app.MapGet("/api/support/tickets", async (HttpContext ctx) =>
        {
            var user = await User(ctx, platform); if (user is null) return Results.Unauthorized(); await using var db = await platform.Data.OpenConnectionAsync();
            return Results.Json(await db.QueryAsync("SELECT id,category,subject,status,created_at,updated_at FROM support_tickets WHERE user_id=@user ORDER BY updated_at DESC", new { user }));
        });
        app.MapGet("/api/support/tickets/{id:guid}", async (HttpContext ctx, Guid id) => await TicketDetail(ctx, platform, id, false));
        app.MapGet("/api/admin/support/tickets", async (HttpContext ctx) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; await using var db = await platform.Data.OpenConnectionAsync();
            return Results.Json(await db.QueryAsync("SELECT t.id,t.category,t.subject,t.status,t.created_at,t.updated_at,u.username FROM support_tickets t JOIN users u ON u.id=t.user_id ORDER BY t.updated_at DESC LIMIT 200"));
        });
        app.MapGet("/api/admin/support/tickets/{id:guid}", async (HttpContext ctx, Guid id) => await TicketDetail(ctx, platform, id, true));
        app.MapPost("/api/admin/support/tickets/{id:guid}/messages", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var text = Text(body, "message").Trim(); if (text.Length is < 1 or > 10000) return Results.BadRequest(); await using var db = await platform.Data.OpenConnectionAsync();
            if (await db.ExecuteAsync("INSERT INTO support_ticket_messages(ticket_id,author_user_id,is_staff,body) SELECT @id,@user,true,@text WHERE EXISTS(SELECT 1 FROM support_tickets WHERE id=@id)", new { id, user, text }) == 0) return Results.NotFound();
            await db.ExecuteAsync("UPDATE support_tickets SET updated_at=now() WHERE id=@id", new { id }); await platform.Audit(user!.Value.ToString(), "support.ticket_replied", null, null, new { ticketId = id }); return Results.Json(new { ok = true });
        });
        app.MapPatch("/api/admin/support/tickets/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var status = Text(body, "status"); if (status is not ("open" or "in_progress" or "resolved" or "closed")) return Results.BadRequest(); await using var db = await platform.Data.OpenConnectionAsync();
            var n = await db.ExecuteAsync("UPDATE support_tickets SET status=@status,updated_at=now() WHERE id=@id", new { id, status }); if (n == 0) return Results.NotFound(); await platform.Audit(user!.Value.ToString(), "support.ticket_status_changed", null, null, new { ticketId = id, status }); return Results.Json(new { ok = true });
        });
        app.MapGet("/api/status/incidents", async () => { await using var db = await platform.Data.OpenConnectionAsync(); return Results.Json(await db.QueryAsync("SELECT id,title,status,details,created_at,updated_at FROM status_incidents ORDER BY created_at DESC LIMIT 100")); });
        app.MapPost("/api/admin/status/incidents", async (HttpContext ctx, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var title = Text(body, "title").Trim(); var status = Text(body, "status"); var details = Text(body, "details").Trim(); if (title.Length is < 3 or > 180 || status.Length is < 3 or > 40 || details.Length > 10000) return Results.BadRequest();
            await using var db = await platform.Data.OpenConnectionAsync(); var id = await db.ExecuteScalarAsync<Guid>("INSERT INTO status_incidents(title,status,details,created_by) VALUES(@title,@status,@details,@user) RETURNING id", new { title, status, details, user }); await platform.Audit(user!.Value.ToString(), "status.incident_created", null, null, new { id }); return Results.Json(new { id });
        });
        app.MapPatch("/api/admin/status/incidents/{id:guid}", async (HttpContext ctx, Guid id, JsonElement body) =>
        {
            var (user, denied) = await Staff(ctx, platform); if (denied is not null) return denied; if (!SameOrigin(ctx)) return Results.StatusCode(403);
            var title = Text(body, "title").Trim(); var status = Text(body, "status"); var details = Text(body, "details").Trim();
            if (title.Length is < 3 or > 180 || status.Length is < 3 or > 40 || details.Length > 10000) return Results.BadRequest();
            await using var db = await platform.Data.OpenConnectionAsync(); var count = await db.ExecuteAsync("UPDATE status_incidents SET title=@title,status=@status,details=@details,updated_at=now() WHERE id=@id", new { id, title, status, details });
            if (count == 0) return Results.NotFound(); await platform.Audit(user!.Value.ToString(), "status.incident_updated", null, null, new { id, status }); return Results.Json(new { ok = true });
        });
    }

    static async Task<object> Profile(System.Data.Common.DbConnection conn, Guid id)
    {
        var me = await conn.QuerySingleAsync<(string Username, string Role, string Status, string DisplayName, string Email, string AvatarUrl, bool ProductUpdates)>(
            "SELECT username, role, status, display_name, coalesce(email, ''), coalesce(avatar_url, ''), product_updates FROM users WHERE id=@id",
            new { id });
        var preferences = await conn.QuerySingleAsync<(string Timezone, string Locale, string Preferences, bool TotpEnabled)>(
            "SELECT timezone, locale, notification_preferences::text, totp_enabled FROM users WHERE id=@id", new { id });
        var linked = (await conn.QueryAsync<IdentityRow>("SELECT provider, label, email FROM user_identities WHERE user_id=@id", new { id })).ToList();
        var owners = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE role='owner' AND status='active'");
        var identities = new List<object>
        {
            new { provider = "password", label = "Password", connected = true, detail = "This sign-in uses your password." }
        };
        foreach (var method in SignInMethods.Optional)
        {
            var match = linked.FirstOrDefault(row => string.Equals(row.Provider, method, StringComparison.OrdinalIgnoreCase));
            identities.Add(new
            {
                provider = method,
                label = SignInMethods.Label(method),
                connected = match != null,
                detail = match == null ? "Not connected." : "Connected."
            });
        }
        return new
        {
            id,
            username = me.Username,
            role = me.Role,
            status = me.Status,
            displayName = string.IsNullOrWhiteSpace(me.DisplayName) ? me.Username : me.DisplayName,
            email = me.Email,
            avatarUrl = me.AvatarUrl.StartsWith("user-avatars/", StringComparison.Ordinal) ? "/api/account/avatar" : me.AvatarUrl,
            productUpdates = me.ProductUpdates,
            timezone = preferences.Timezone,
            locale = preferences.Locale,
            preferences = preferences.Preferences,
            totpEnabled = preferences.TotpEnabled,
            canDelete = AccountInput.CanDelete(me.Role, owners),
            identities
        };
    }

    internal static async Task EnsureBilling(System.Data.Common.DbConnection conn, Guid id)
    {
        var free = PlanCatalog.Find("free")!;
        await conn.ExecuteAsync(
            """
            INSERT INTO billing_accounts (user_id, plan_id, credit_balance, credit_allowance, provider)
            SELECT u.id,u.plan_id,LEAST(1000000,p.weekly_credits*4)::int,LEAST(1000000,p.weekly_credits*4)::int,'mock' FROM users u JOIN billing_plans p ON p.id=u.plan_id WHERE u.id=@id
            ON CONFLICT (user_id) DO NOTHING
            """,
            new { id, credits = free.MonthlyCredits });
    }

    static async Task<BillingRow> LoadBilling(System.Data.Common.DbConnection conn, Guid id)
    {
        await EnsureBilling(conn, id);
        var row = await conn.QuerySingleAsync<BillingRow>("SELECT plan_id, credit_balance, credit_allowance, period_start, provider FROM billing_accounts WHERE user_id=@id", new { id });
        var now = DateTime.UtcNow;
        if (BillingMath.PeriodElapsed(row.PeriodStart, now))
        {
            row.CreditBalance = row.CreditAllowance;
            row.PeriodStart = new DateTime(now.Year, now.Month, 1, 0, 0, 0, DateTimeKind.Utc);
            await conn.ExecuteAsync(
                "UPDATE billing_accounts SET credit_balance=@balance, period_start=@start, updated_at=now() WHERE user_id=@id",
                new { id, balance = row.CreditBalance, start = row.PeriodStart });
        }
        return row;
    }

    static async Task<object> Billing(System.Data.Common.DbConnection conn, Platform platform, Guid id)
    {
        var row = await LoadBilling(conn, id);
        var invoices = await conn.QueryAsync<InvoiceRow>("SELECT id, number, plan_id, amount_cents, currency, status, provider, issued_at FROM invoices WHERE user_id=@id ORDER BY issued_at DESC", new { id });
        var mock = string.Equals(platform.LlmProvider, "mock", StringComparison.OrdinalIgnoreCase);
        var plans = await conn.QueryAsync<BillingPlan>("SELECT " + UsageMeter.PlanColumns() + " FROM billing_plans ORDER BY price_usd");
        var currentPlan = await conn.ExecuteScalarAsync<string>("SELECT plan_id FROM users WHERE id=@id", new { id });
        var summary = await platform.Usage.SummaryAsync(id, fresh: true);
        var usage = await conn.QuerySingleAsync<(long Calls, decimal Cost, double Latency)>("SELECT count(*) AS calls,coalesce(sum(cost_usd),0) AS cost,coalesce(avg(latency_ms),0)::float8 AS latency FROM model_calls WHERE owner_id=@id AND created_at >= date_trunc('month',now())", new { id });
        var breakdown = await conn.QueryAsync("SELECT role AS category,count(*) AS calls,coalesce(sum(cost_usd),0) AS cost_usd FROM model_calls WHERE owner_id=@id AND created_at >= date_trunc('month',now()) GROUP BY role ORDER BY cost_usd DESC", new { id });
        var published = await conn.ExecuteScalarAsync<string>("SELECT plans::text FROM billing_configuration WHERE id=true");
        return new
        {
            planId = currentPlan ?? row.PlanId,
            plan = plans.FirstOrDefault(plan => plan.Id == (currentPlan ?? row.PlanId))?.Name,
            periodStart = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1, 0, 0, 0, DateTimeKind.Utc),
            periodEnd = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1, 0, 0, 0, DateTimeKind.Utc).AddMonths(1),
            usage = new { modelCalls = usage.Calls, costUsd = usage.Cost, latencyMs = usage.Latency },
            breakdown,
            pricingConfigured = published is not null && published != "[]",
            creditBalance = Math.Max(0, summary.Allowance - summary.UsedCredits),
            creditAllowance = summary.Allowance,
            usedCredits = summary.UsedCredits,
            usedPercent = summary.Percent,
            provider = BillingProviders.Mock,
            chargesCard = false,
            mockMode = mock,
            renewsAt = summary.ResetsAt,
            period = "week",
            plans = plans.Select(plan => new { id = plan.Id, name = plan.Name, detail = "Weekly usage plan", priceCents = (int)(plan.PriceUsd * 100), monthlyCredits = (int)Math.Min(1_000_000, plan.WeeklyCredits * 4), weeklyCredits = plan.WeeklyCredits, features = new[] { $"{plan.WeeklyCredits:N0} credits each week", $"{plan.StorageQuotaGb} GB storage" } }),
            invoices = invoices.Select(item => new
            {
                id = item.Id,
                number = item.Number,
                planId = item.PlanId,
                amountCents = item.AmountCents,
                amount = item.AmountCents / 100m,
                date = DateTime.SpecifyKind(item.IssuedAt, DateTimeKind.Utc),
                currency = item.Currency,
                status = item.Status,
                provider = item.Provider,
                issuedAt = DateTime.SpecifyKind(item.IssuedAt, DateTimeKind.Utc)
            })
        };
    }

    static async Task<(string Id, string Label)> Model(System.Data.Common.DbConnection conn)
    {
        var id = await conn.ExecuteScalarAsync<string>("SELECT value FROM platform_settings WHERE key='model_id'");
        var label = await conn.ExecuteScalarAsync<string>("SELECT value FROM platform_settings WHERE key='model_label'");
        if (!PlatformModel.ValidId(id)) id = PlatformModel.DefaultId;
        if (!PlatformModel.ValidLabel(label)) label = PlatformModel.DefaultLabel;
        return (id!, label!.Trim());
    }

    static async Task<Dictionary<string, int>> Allowances(System.Data.Common.DbConnection conn) =>
        (await conn.QueryAsync<(string Id, long Credits)>("SELECT id,weekly_credits FROM billing_plans"))
            .ToDictionary(row => row.Id,row => (int)Math.Min(int.MaxValue,row.Credits));

    static async Task Upsert(System.Data.Common.DbConnection conn, string key, string value)
    {
        await conn.ExecuteAsync(
            """
            INSERT INTO platform_settings (key, value, updated_at) VALUES (@key, @value, now())
            ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()
            """,
            new { key, value });
    }

    static async Task<string?> Role(System.Data.Common.DbConnection conn, Guid id) =>
        await conn.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@id", new { id });

    static async Task<Guid?> User(HttpContext ctx, Platform platform)
    {
        ctx.Request.Cookies.TryGetValue("teammates_session", out var token);
        return await platform.UserForSession(token);
    }

    static string? Str(JsonElement body, string name) =>
        body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    private static async Task<IResult> TicketDetail(HttpContext ctx, Platform p, Guid id, bool staffOnly)
    {
        var user = await User(ctx, p); if (user is null) return Results.Unauthorized(); await using var db = await p.Data.OpenConnectionAsync();
        var role = await db.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@user", new { user }); var staff = Access.IsStaff(role);
        if (staffOnly && !AccountSecurityPolicy.CanManageSupport(role)) return Results.Json(new { error = "forbidden" }, statusCode: 403);
        var ticket = await db.QuerySingleOrDefaultAsync("SELECT t.id,t.user_id,t.category,t.subject,t.status,t.created_at,t.updated_at,u.username FROM support_tickets t JOIN users u ON u.id=t.user_id WHERE t.id=@id", new { id });
        if (ticket is not null && !AccountSecurityPolicy.CanReadTicket((Guid)ticket.user_id, user.Value, staff)) return Results.NotFound();
        if (ticket is null) return Results.NotFound(); var messages = await db.QueryAsync("SELECT id,author_user_id,is_staff,body,attachment_name,attachment_content_type,encode(attachment_data,'base64') AS attachment_base64,created_at FROM support_ticket_messages WHERE ticket_id=@id ORDER BY created_at", new { id });
        return Results.Json(new { ticket, messages });
    }
    private static async Task<(Guid? User, IResult? Denied)> Staff(HttpContext ctx, Platform p)
    { var u = await User(ctx, p); if (u is null) return (null, Results.Unauthorized()); await using var db = await p.Data.OpenConnectionAsync(); return AccountSecurityPolicy.CanManageSupport(await db.ExecuteScalarAsync<string>("SELECT role FROM users WHERE id=@u", new { u })) ? (u, null) : (u, Results.Json(new { error = "forbidden" }, statusCode: 403)); }
    private static bool SameOrigin(HttpContext ctx)
    {
        var origin = ctx.Request.Headers.Origin.ToString(); if (origin.Length == 0) return true;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri) || !string.Equals(uri.Host, ctx.Request.Host.Host, StringComparison.OrdinalIgnoreCase)) return false;
        var expectedPort = ctx.Request.Host.Port ?? (ctx.Request.Headers["X-Forwarded-Proto"] == "https" ? 443 : 80);
        return uri.Port == expectedPort;
    }
    private static string Text(JsonElement body, string name) => body.ValueKind == JsonValueKind.Object && body.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    private static string TokenHash(HttpContext ctx) { ctx.Request.Cookies.TryGetValue("teammates_session", out var token); return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token ?? ""))).ToLowerInvariant(); }
    private static string Hash(string value) => TokenDigest(value);
    private static string TokenDigest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static string Base32(ReadOnlySpan<byte> data)
    { const string chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; var sb = new StringBuilder(); var buffer = 0; var bits = 0; foreach (var b in data) { buffer = (buffer << 8) | b; bits += 8; while (bits >= 5) { sb.Append(chars[(buffer >> (bits - 5)) & 31]); bits -= 5; } } if (bits > 0) sb.Append(chars[(buffer << (5 - bits)) & 31]); return sb.ToString(); }
    private static string DeviceName(string ua) => ua.Contains("Windows", StringComparison.OrdinalIgnoreCase) ? "Windows device" : ua.Contains("Mac OS", StringComparison.OrdinalIgnoreCase) ? "Mac device" : ua.Contains("Android", StringComparison.OrdinalIgnoreCase) ? "Android device" : ua.Contains("iPhone", StringComparison.OrdinalIgnoreCase) ? "iPhone" : ua.Contains("iPad", StringComparison.OrdinalIgnoreCase) ? "iPad" : ua.Contains("Linux", StringComparison.OrdinalIgnoreCase) ? "Linux device" : ua.Length == 0 ? "Unknown device" : "Device";
    private static string BrowserName(string ua) => ua.Contains("Edg/", StringComparison.OrdinalIgnoreCase) ? "Microsoft Edge" : ua.Contains("Firefox/", StringComparison.OrdinalIgnoreCase) ? "Firefox" : ua.Contains("Chrome/", StringComparison.OrdinalIgnoreCase) ? "Chrome" : ua.Contains("Safari/", StringComparison.OrdinalIgnoreCase) ? "Safari" : ua.Length == 0 ? "Unknown browser" : "Browser";

    public static async Task<IResult> StartLoginChallenge(HttpContext ctx, Platform p, Guid user)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant(); var digest = TokenDigest(token);
        await using var db = await p.Data.OpenConnectionAsync(); await db.ExecuteAsync("INSERT INTO login_totp_challenges(token_hash,user_id,expires_at) VALUES(@digest,@user,now()+interval '5 minutes') ON CONFLICT(token_hash) DO NOTHING", new { digest, user });
        ctx.Response.Cookies.Append("teammates_login_challenge", token, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = ctx.Request.Headers["X-Forwarded-Proto"] == "https", Path = "/api/auth/login/totp", MaxAge = TimeSpan.FromMinutes(5) });
        return Results.Json(new { totpRequired = true });
    }

    public static async Task EstablishSession(HttpContext ctx, Platform p, Guid user)
    {
        var token = await p.CreateSession(user, ClientAddress.From(ctx)); var hash = TokenDigest(token);
        var ip = ClientAddress.From(ctx); var ua = ctx.Request.Headers.UserAgent.ToString(); if (ua.Length > 500) ua = ua[..500];
        await using var db = await p.Data.OpenConnectionAsync(); await db.ExecuteAsync("UPDATE sessions SET user_agent=@ua,ip_address=CASE WHEN @ip ~ '^[0-9a-fA-F:.]+$' THEN @ip::inet ELSE NULL END,last_active_at=now() WHERE token_hash=@hash", new { hash, ua, ip });
        ctx.Response.Cookies.Append("teammates_session", token, new CookieOptions { HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = ctx.Request.Headers["X-Forwarded-Proto"] == "https", Path = "/", MaxAge = TimeSpan.FromDays(14) });
    }
}
