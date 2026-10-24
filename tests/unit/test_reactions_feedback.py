from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_feedback_is_redelivered_until_successful_completion():
    routes = (ROOT / "apps/api/Routes.cs").read_text()
    lease = routes.split("UPDATE bot_feedback SET task_id=@task", 1)[1].split("RETURNING message_id", 1)[0]
    assert "consumed_at=now()" not in lease
    assert "f.task_id=@task" in lease
    assert "o.status NOT IN ('completed','failed','cancelled')" in lease
    transcript = routes.split('app.MapPut("/internal/tasks/{id:guid}/transcript"', 1)[1].split('app.MapPost(', 1)[0]
    assert "consumed_at" not in transcript
    assert "FeedbackDelivery.CompleteSql" in routes
    sql = (ROOT / "apps/api/FeedbackDelivery.cs").read_text()
    assert "lease_epoch=@epoch" in sql and "FROM completed c" in sql
    assert "FROM task_transcript" in sql and "f.message_id::text" in sql
