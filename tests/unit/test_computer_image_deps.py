"""Every third-party module the computer service imports must be pip-installed in its image."""
import ast
import sys
from pathlib import Path

C = Path(__file__).resolve().parents[2] / "services/computer"


def test_dockerfile_installs_every_third_party_import():
    local = {p.stem for p in (C / "src").glob("*.py")} | {p.name for p in (C / "src").iterdir() if p.is_dir()}
    third = set()
    for f in (C / "src").rglob("*.py"):
        for n in ast.walk(ast.parse(f.read_text())):
            if isinstance(n, ast.Import):
                third |= {a.name.split(".")[0] for a in n.names}
            elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
                third.add(n.module.split(".")[0])
    third -= set(sys.stdlib_module_names) | local
    docker = (C / "Dockerfile").read_text().lower()
    missing = sorted(m for m in third if m not in docker)
    assert not missing, missing
