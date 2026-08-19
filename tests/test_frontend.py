import shutil
import subprocess
from pathlib import Path

import pytest


def test_frontend_uses_comfy_extension_import_depth():
    script = (
        Path(__file__).resolve().parents[1]
        / "web"
        / "js"
        / "load_image_path.js"
    ).read_text(encoding="utf-8")

    assert 'from "../../../scripts/app.js"' in script
    assert 'from "../../../scripts/api.js"' in script
    assert 'from "./server_path_browser.js"' in script
    assert 'objectFit: "contain"' in script
    assert "node.resizable = true" in script
    assert "enhanceServerPathWidget" in script


def test_path_browser_uses_file_helper_suite_names_only():
    script = (
        Path(__file__).resolve().parents[1]
        / "web"
        / "js"
        / "server_path_browser.js"
    ).read_text(encoding="utf-8")

    assert 'SERVER_PATH_ROUTE = "/fhs/list-path"' in script
    assert 'PATH_WIDGET_TYPE = "FHS.PATH"' in script
    assert "VHS" not in script.upper()


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is unavailable")
def test_path_browser_interactions():
    test_script = (
        Path(__file__).resolve().parents[1]
        / "tests"
        / "frontend_path_browser.test.mjs"
    )

    subprocess.run(
        ["node", "--test", str(test_script)],
        check=True,
        capture_output=True,
        text=True,
    )
