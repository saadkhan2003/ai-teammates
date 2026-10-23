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


def test_stdlib_modules_used_as_attributes_are_imported():
    """server.py once used asyncio.create_task without importing it, so the computer API never started."""
    import re
    for f in (C / "src").rglob("*.py"):
        text = f.read_text()
        for mod in ("asyncio", "json", "os", "time", "threading", "subprocess"):
            if re.search(rf"(?<![\w.]){mod}\.\w+\(", text):
                assert re.search(rf"^\s*(import {mod}\b|from {mod}\b)", text, re.M), f"{f.name} uses {mod} without importing it"


def test_chrome_flags_are_shell_quoted_in_the_s6_run_script():
    # An unquoted "MAP * ~NOTFOUND" glob-expanded to s6 directory names and broke the resolver rule.
    import shlex
    import sys
    sys.path.insert(0, str(C / "src"))
    import desktops
    quoted = " ".join(shlex.quote(flag) for flag in desktops.CHROME_FLAGS)
    assert "'--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1 , EXCLUDE ::1'" in quoted
    assert "shlex.quote(flag) for flag in CHROME_FLAGS" in (C / "src/desktops.py").read_text()


def test_computer_pids_limit_leaves_room_for_chromium_threads():
    import re
    from pathlib import Path

    source = (Path(__file__).resolve().parents[2] / "src" / "Compute.Docker" / "DockerComputeProvider.cs").read_text()
    limit = int(re.search(r"PidsLimit = (\d+),", source).group(1))
    assert limit >= 768  # pids cgroup counts threads; 256 starved Chromium with ~8 tabs
