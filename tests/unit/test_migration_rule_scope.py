import pathlib
import re

DB = pathlib.Path(__file__).resolve().parents[2] / "db"


def test_rule_scope_does_not_reuse_legacy_memories_scope_column():
    assert re.search(r"memories\s*\(.*?scope text NOT NULL DEFAULT 'bot'", (DB / "001_init.sql").read_text(), re.S)
    sql = (DB / "031_rule_scope.sql").read_text()
    assert "ADD COLUMN IF NOT EXISTS rule_scope text" in sql
    assert not re.search(r"(?<!rule_)\bscope\b\s*(IS|=|~)", sql)
