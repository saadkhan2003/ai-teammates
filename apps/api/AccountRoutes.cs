using System.Text.Json;
using Dapper;

namespace Teammates.Api;

public static class AccountRoutes
{
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
                if (!AccountInput.ValidAvatar(avatar)) return Results.BadRequest(new { error = "Use a small image or an https link." });
                await conn.ExecuteAsync("UPDATE users SET avatar_url=@avatar WHERE id=@id", new { id = user, avatar });
            }
            if (body.TryGetProperty("productUpdates", out var updates) && updates.ValueKind is JsonValueKind.True or JsonValueKind.False)
                await conn.ExecuteAsync("UPDATE users SET product_updates=@value WHERE id=@id", new { id = user, value = updates.GetBoolean() });
            return Results.Json(await Profile(conn, user.Value));
        });

        app.MapPost("/api/account/password", async (HttpContext ctx, JsonElement body) =>
        {
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            var current = Str(body, "currentPassword") ?? "";
            var next = Str(body, "newPassword") ?? "";
            if (!AccountInput.ValidPassword(next)) return Results.BadRequest(new { error = "Use at least 8 characters." });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var hash = await conn.ExecuteScalarAsync<string>("SELECT password_hash FROM users WHERE id=@id", new { id = user });
            if (!Passwords.Verify(current, hash ?? "")) return Results.Json(new { error = "The current password is wrong." }, statusCode: 403);
            await conn.ExecuteAsync("UPDATE users SET password_hash=@hash WHERE id=@id", new { id = user, hash = Passwords.Hash(next) });
            await platform.Audit(user.Value.ToString(), "account.password", null, null, new { changed = true });
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
            var user = await User(ctx, platform);
            if (user == null) return Results.Unauthorized();
            if (!string.Equals(Str(body, "confirm"), "DELETE", StringComparison.Ordinal))
                return Results.BadRequest(new { error = "Type DELETE to confirm." });
            await using var conn = await platform.Data.OpenConnectionAsync();
            var row = await conn.QuerySingleAsync<(string Role, string Hash)>("SELECT role, password_hash FROM users WHERE id=@id", new { id = user });
            if (!Passwords.Verify(Str(body, "password") ?? "", row.Hash ?? ""))
                return Results.Json(new { error = "The password is wrong." }, statusCode: 403);
            var owners = await conn.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE role='owner' AND status='active'");
            if (!AccountInput.CanDelete(row.Role, owners))
                return Results.Json(new { error = "The only owner cannot delete this account." }, statusCode: 409);
            await platform.Audit(user.Value.ToString(), "account.deleted", null, null, new { role = row.Role });
            await conn.ExecuteAsync("DELETE FROM users WHERE id=@id", new { id = user });
            ctx.Response.Cookies.Delete("teammates_session");
            return Results.Json(new { ok = true });
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

        app.MapGet("/api/status", async () =>
        {
            await using var conn = await platform.Data.OpenConnectionAsync();
            return Results.Json(await UptimeBoard.Load(conn));
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
            var remaining = (int)Math.Min(int.MaxValue, Math.Max(0, summary.Allowance - summary.UsedCredits));
            var grant = delta ?? (setTo is { } requested ? requested - remaining : 0);
            if (grant != 0) await conn.ExecuteAsync("INSERT INTO credit_ledger(user_id,kind,credits,note,actor_id) VALUES(@id,'grant',@grant,'staff balance adjustment',@actor)", new { id, grant, actor });
            platform.Usage.Invalidate(id);
            await platform.Audit(actor.Value.ToString(), "billing.adjust", null, null, new { userId = id, planId, balance });
            return Results.Json(new { id, planId, creditBalance = balance, creditAllowance = allowance });
        });
    }

    static async Task<object> Profile(System.Data.Common.DbConnection conn, Guid id)
    {
        var me = await conn.QuerySingleAsync<(string Username, string Role, string Status, string DisplayName, string Email, string AvatarUrl, bool ProductUpdates)>(
            "SELECT username, role, status, display_name, coalesce(email, ''), coalesce(avatar_url, ''), product_updates FROM users WHERE id=@id",
            new { id });
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
            avatarUrl = me.AvatarUrl,
            productUpdates = me.ProductUpdates,
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
        return new
        {
            planId = currentPlan ?? row.PlanId,
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
}
