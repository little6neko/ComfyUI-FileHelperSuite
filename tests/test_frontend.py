from pathlib import Path


def test_frontend_uses_comfy_extension_import_depth():
    script = (
        Path(__file__).resolve().parents[1]
        / "web"
        / "js"
        / "load_image_path.js"
    ).read_text(encoding="utf-8")

    assert 'from "../../../scripts/app.js"' in script
    assert 'from "../../../scripts/api.js"' in script
    assert 'objectFit: "contain"' in script
    assert "node.resizable = true" in script
