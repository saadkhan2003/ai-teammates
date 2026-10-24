"""Link pills render from the same guide the bot is allowed to use."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_known_app_links_render_as_pills_and_unknown_ones_are_text():
    subprocess.check_call(
        ["node", "--no-warnings", "--import", "./tests/unit/register-ts.mjs", "tests/unit/app-link-pills.test.ts"],
        cwd=ROOT,
    )
