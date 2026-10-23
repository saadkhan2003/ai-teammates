using Dapper;
using Npgsql;

namespace Teammates.Api;

public sealed record DesktopLeaseRow(Guid ComputerId, int Display, string HolderKind, Guid? HolderUserId,
    string? TabId, long Epoch, DateTime ExpiresAt, DateTime UpdatedAt);

/// <summary>Postgres is the lease authority; mutations use DB time and epoch CAS.</summary>
public static class DesktopLeaseRepository
{
    public static async Task<DesktopLeaseRow?> AcquireAsync(NpgsqlConnection conn, Guid computerId, int display,
        Guid userId, string tabId, long expectedEpoch, bool transfer, CancellationToken ct)
    {
        Validate(display, tabId);
        const string sql = """
            INSERT INTO desktop_lease (computer_id, display, holder_kind, holder_user_id, tab_id, epoch, expires_at, updated_at)
            VALUES (@computerId, @display, 'human', @userId, @tabId, 1,
                    clock_timestamp() + interval '35 seconds', clock_timestamp())
            ON CONFLICT (computer_id, display) DO UPDATE SET
              holder_kind='human', holder_user_id=EXCLUDED.holder_user_id, tab_id=EXCLUDED.tab_id,
              epoch=desktop_lease.epoch + CASE
                WHEN desktop_lease.holder_kind='none' OR desktop_lease.expires_at <= clock_timestamp()
                  OR desktop_lease.holder_user_id IS DISTINCT FROM EXCLUDED.holder_user_id
                  OR desktop_lease.tab_id IS DISTINCT FROM EXCLUDED.tab_id THEN 1 ELSE 0 END,
              expires_at=clock_timestamp() + interval '35 seconds', updated_at=clock_timestamp(), release_after=NULL
            WHERE desktop_lease.epoch=@expectedEpoch
              AND (desktop_lease.holder_kind IN ('none','agent') OR desktop_lease.expires_at <= clock_timestamp()
                   OR (desktop_lease.holder_user_id=@userId AND
                       (desktop_lease.tab_id=@tabId OR (@transfer AND desktop_lease.tab_id<>@tabId))))
            RETURNING computer_id AS "ComputerId", display AS "Display", holder_kind AS "HolderKind",
              holder_user_id AS "HolderUserId", tab_id AS "TabId", epoch AS "Epoch",
              expires_at AS "ExpiresAt", updated_at AS "UpdatedAt"
            """;
        return await conn.QuerySingleOrDefaultAsync<DesktopLeaseRow>(new CommandDefinition(sql,
            new { computerId, display, userId, tabId, expectedEpoch, transfer }, cancellationToken: ct));
    }

    public static async Task<DesktopLeaseRow?> ReleaseAsync(NpgsqlConnection conn, Guid computerId, int display,
        Guid userId, string tabId, long expectedEpoch, CancellationToken ct)
    {
        Validate(display, tabId);
        const string sql = """
            UPDATE desktop_lease SET holder_kind='none', holder_user_id=NULL, tab_id=NULL,
              epoch=epoch+1, expires_at=clock_timestamp(), updated_at=clock_timestamp(), release_after=NULL
            WHERE computer_id=@computerId AND display=@display AND epoch=@expectedEpoch
              AND holder_kind='human' AND holder_user_id=@userId AND tab_id=@tabId
              AND expires_at > clock_timestamp()
            RETURNING computer_id AS "ComputerId", display AS "Display", holder_kind AS "HolderKind",
              holder_user_id AS "HolderUserId", tab_id AS "TabId", epoch AS "Epoch",
              expires_at AS "ExpiresAt", updated_at AS "UpdatedAt"
            """;
        return await conn.QuerySingleOrDefaultAsync<DesktopLeaseRow>(new CommandDefinition(sql,
            new { computerId, display, userId, tabId, expectedEpoch }, cancellationToken: ct));
    }

    public static async Task<DesktopLeaseRow?> ResumeAgentAsync(NpgsqlConnection conn, Guid computerId, int display,
        Guid userId, long expectedEpoch, CancellationToken ct)
    {
        const string sql = """
            UPDATE desktop_lease SET holder_kind='agent', holder_user_id=@userId, tab_id=NULL,
              epoch=epoch+1, expires_at=clock_timestamp()+interval '90 seconds', updated_at=clock_timestamp()
            WHERE computer_id=@computerId AND display=@display AND epoch=@expectedEpoch
              AND holder_kind='none'
            RETURNING computer_id AS "ComputerId", display AS "Display", holder_kind AS "HolderKind",
              holder_user_id AS "HolderUserId", tab_id AS "TabId", epoch AS "Epoch",
              expires_at AS "ExpiresAt", updated_at AS "UpdatedAt"
            """;
        return await conn.QuerySingleOrDefaultAsync<DesktopLeaseRow>(new CommandDefinition(sql,
            new { computerId, display, userId, expectedEpoch }, cancellationToken: ct));
    }

    public static async Task<DesktopLeaseRow?> ForceReleaseAsync(NpgsqlConnection conn, Guid computerId, int display,
        long expectedEpoch, CancellationToken ct)
    {
        Validate(display, "force-release");
        return await conn.QuerySingleOrDefaultAsync<DesktopLeaseRow>(new CommandDefinition("""
            UPDATE desktop_lease SET holder_kind='none', holder_user_id=NULL, tab_id=NULL,
              epoch=epoch+1, expires_at=clock_timestamp(), updated_at=clock_timestamp(), release_after=NULL
            WHERE computer_id=@computerId AND display=@display AND epoch=@expectedEpoch AND holder_kind <> 'none'
            RETURNING computer_id AS "ComputerId", display AS "Display", holder_kind AS "HolderKind",
              holder_user_id AS "HolderUserId", tab_id AS "TabId", epoch AS "Epoch",
              expires_at AS "ExpiresAt", updated_at AS "UpdatedAt"
            """, new { computerId, display, expectedEpoch }, cancellationToken: ct));
    }

    public static Task<DesktopLeaseRow?> StateAsync(NpgsqlConnection conn, Guid computerId, int display, CancellationToken ct) =>
        conn.QuerySingleOrDefaultAsync<DesktopLeaseRow>(new CommandDefinition("""
            SELECT computer_id AS "ComputerId", display AS "Display", holder_kind AS "HolderKind",
              holder_user_id AS "HolderUserId", tab_id AS "TabId", epoch AS "Epoch",
              expires_at AS "ExpiresAt", updated_at AS "UpdatedAt"
            FROM desktop_lease WHERE computer_id=@computerId AND display=@display
            """, new { computerId, display }, cancellationToken: ct));

    public static bool IsActiveFor(DesktopLeaseRow? row, Guid user, string tabId, long epoch, DateTimeOffset dbNow) =>
        row is { HolderKind: "human" } && row.HolderUserId == user && row.TabId == tabId && row.Epoch == epoch && row.ExpiresAt > dbNow.UtcDateTime;

    private static void Validate(int display, string tabId)
    {
        if (display is < 1 or > 2 || string.IsNullOrWhiteSpace(tabId) || tabId.Length > 128)
            throw new ArgumentException("invalid desktop lease scope");
    }
}
