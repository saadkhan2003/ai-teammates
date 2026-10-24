from pathlib import Path


def test_feedback_is_redelivered_until_transcript_is_persisted():
    routes = (Path(__file__).resolve().parents[2] / "apps/api/Routes.cs").read_text()
    lease = routes.split("UPDATE bot_feedback SET task_id=@task", 1)[1].split("RETURNING message_id", 1)[0]
    assert "consumed_at=now()" not in lease
    assert "f.task_id=@task" in lease
    assert "UPDATE bot_feedback SET consumed_at=now() WHERE task_id=@id AND consumed_at IS NULL" in routes
