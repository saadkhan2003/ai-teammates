namespace Teammates.Api;

public static class FeedbackDelivery
{
    // A checkpoint/transcript save is not success. Failed, suspended and expired
    // attempts keep their feedback so the next lease can fold it in again.
    // Only consume notes actually present in the successful run's transcript.
    public const string CompleteSql = """
        WITH completed AS (
            UPDATE tasks SET status='completed', result=@result::jsonb,
                finished_at=now(), lease_owner=NULL, lease_until=NULL, updated_at=now()
            WHERE id=@id AND status='running' AND lease_epoch=@epoch
            RETURNING id, conversation_id
        ), consumed AS (
            UPDATE bot_feedback f SET consumed_at=now()
            FROM completed c
            WHERE f.task_id=c.id AND f.consumed_at IS NULL
              AND EXISTS (SELECT 1 FROM task_transcript t WHERE t.task_id=c.id AND t.role='system'
                  AND position('Hidden feedback, not chat and no reply expected: the user ' || f.action || ' ' || f.emoji || ' on message ' || f.message_id::text || '.' in t.content)>0)
            RETURNING f.id
        ), signals_consumed AS (
            UPDATE approval_signals s SET consumed_at=now() FROM completed c
            WHERE s.task_id=c.id AND s.consumed_at IS NULL
              AND EXISTS(SELECT 1 FROM task_transcript t WHERE t.task_id=c.id AND t.role='system'
                  AND position('[approval-signal:' || s.id::text || ']' in t.content)>0)
            RETURNING s.id
        )
        SELECT conversation_id, 1 AS applied FROM completed
        """;
}
