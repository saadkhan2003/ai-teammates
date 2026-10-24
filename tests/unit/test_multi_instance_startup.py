"""Regressions found by the first live two-instance run."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_hosted_services_can_resolve_the_data_source():
    program = (ROOT / "apps/api/Program.cs").read_text()
    assert "builder.Services.AddSingleton(data);" in program
    assert program.index("builder.Services.AddSingleton(data);") < program.index("AddHostedService<TicketCleanupService>")


def test_migrations_hold_a_cluster_wide_lock_so_instances_can_start_together():
    platform = (ROOT / "apps/api/Platform.cs").read_text()
    assert "pg_advisory_lock(840020)" in platform and "pg_advisory_unlock(840020)" in platform


def test_workspace_script_run_by_the_api_can_import_the_egress_package():
    """workspace.py is shipped to the API as a `python3 -c` script and imports egress.firewall."""
    fs = (ROOT / "apps/api/BotFs.cs").read_text()
    assert "from egress import" in (ROOT / "services/computer/src/workspace.py").read_text()
    assert '["PYTHONPATH"] = "/opt/desk/src"' in fs
